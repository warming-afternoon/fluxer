// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ChannelID, GuildID, UserID} from '@app/api/BrandedTypes';
import type {ChannelRepository} from '@app/api/channel/ChannelRepository';
import {channelToContentWarningView, computeEffectiveChannelNsfw} from '@app/api/channel/utils/EffectiveContentWarning';
import {GuildRepository} from '@app/api/guild/repositories/GuildRepository';
import type {Channel} from '@app/api/models/Channel';
import {forumNsfwGuildId} from '@app/api/user/NsfwDisplayScope';
import {UserSettingsRepository} from '@app/api/user/repositories/UserSettingsRepository';
import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import {THREAD_CHANNEL_TYPES, THREAD_PARENT_CHANNEL_TYPES} from '@fluxer/constants/src/ThreadConstants';
import {UnknownChannelError} from '@fluxer/errors/src/domains/channel/UnknownChannelError';
import {ServiceUnavailableError} from '@fluxer/errors/src/domains/core/ServiceUnavailableError';

/** 判断社区是否属于明确配置的集成显示偏好范围。 */
export function isNsfwVisibilityGuild(guildId: GuildID | null): boolean {
	// 非目标社区不受集成显示偏好影响。
	return guildId !== null && guildId.toString() === forumNsfwGuildId();
}

/** 仅在单次请求内复用可见性读取，不跨请求缓存用户偏好或依赖在线会话。 */
export class NsfwVisibility {
	// 当前请求内按社区复用偏好读取。
	private readonly preferences = new Map<GuildID, Promise<boolean>>();

	// 当前请求内按社区复用内容分级读取。
	private readonly guildNsfw = new Map<GuildID, Promise<boolean>>();

	// 当前请求内复用频道及父频道读取。
	private readonly channels = new Map<ChannelID, Promise<Channel | null>>();

	/** 注入请求用户及可见性判断所需的仓储。 */
	constructor(
		// 当前请求的用户标识。
		private readonly userId: UserID,

		// 读取频道及父级关系。
		private readonly channelRepository: Pick<ChannelRepository, 'channelData'>,

		// 读取社区级内容分级。
		private readonly guildRepository: Pick<GuildRepository, 'findUnique'> = new GuildRepository(),

		// 读取用户在目标社区的显示偏好。
		private readonly settingsRepository: Pick<
			UserSettingsRepository,
			'findGuildSettings'
		> = new UserSettingsRepository(),
	) {}

	/** 批量读取频道，依赖失败时返回不可用错误而非绕过过滤。 */
	async readChannels(channelIds: Array<ChannelID>): Promise<Array<Channel>> {
		// 批量读取复用统一失败处理，避免分类不明时泄漏频道。
		return this.readDependency(() => this.channelRepository.channelData.listChannels(channelIds));
	}

	/** 对不可见频道返回与未知频道相同的错误。 */
	async assertVisible(channel: Channel): Promise<void> {
		// 不向调用方暴露被隐藏频道的存在。
		if (!(await this.isVisible(channel))) throw new UnknownChannelError();
	}

	/** 复用本批频道读取结果，按原始顺序返回可见频道。 */
	async filter(channels: ReadonlyArray<Channel>): Promise<Array<Channel>> {
		// 预先缓存本批频道，使已加载的父级无需重复查询。
		for (const channel of channels) this.channels.set(channel.id, Promise.resolve(channel));
		const visible = await Promise.all(channels.map((channel) => this.isVisible(channel)));
		return channels.filter((_, index) => visible[index]);
	}

	/** 综合用户偏好与频道、分类和社区分级判断可见性。 */
	async isVisible(channel: Channel): Promise<boolean> {
		// 目标社区之外保持原生行为；目标社区显式开启后无需继续分级。
		const guildId = channel.guildId;
		if (guildId === null || !isNsfwVisibilityGuild(guildId)) return true;
		let preference = this.preferences.get(guildId);
		if (!preference) {
			preference = this.readDependency(
				async () => (await this.settingsRepository.findGuildSettings(this.userId, guildId))?.showNsfw === true,
			);
			this.preferences.set(guildId, preference);
		}
		if (await preference) return true;
		// 主题继承父频道分级，缺失或跨社区的父级关系一律隐藏。
		let scope = channel;
		if (THREAD_CHANNEL_TYPES.has(channel.type)) {
			const parent = channel.parentId === null ? null : await this.findChannel(channel.parentId);
			if (!parent || parent.guildId !== guildId || !THREAD_PARENT_CHANNEL_TYPES.has(parent.type)) return false;
			scope = parent;
		}
		const category =
			scope.parentId !== null && scope.type !== ChannelTypes.GUILD_CATEGORY
				? await this.findChannel(scope.parentId)
				: null;
		if (
			scope.parentId !== null &&
			scope.type !== ChannelTypes.GUILD_CATEGORY &&
			(!category || category.guildId !== guildId || category.type !== ChannelTypes.GUILD_CATEGORY)
		)
			return false;
		let nsfw = this.guildNsfw.get(guildId);
		if (!nsfw) {
			nsfw = this.readDependency(async () => {
				const guild = await this.guildRepository.findUnique(guildId);
				if (!guild) throw new UnknownChannelError();
				return guild.nsfw;
			});
			this.guildNsfw.set(guildId, nsfw);
		}
		return !computeEffectiveChannelNsfw(
			channelToContentWarningView(scope),
			category ? channelToContentWarningView(category) : null,
			{nsfw: await nsfw, contentWarningLevel: 0, contentWarningText: null},
		);
	}

	/** 在单次请求内合并同一频道的并发读取。 */
	private findChannel(channelId: ChannelID): Promise<Channel | null> {
		// 缓存 Promise，使并发判断也能共用尚未完成的读取。
		let result = this.channels.get(channelId);
		if (!result) {
			result = this.readDependency(() => this.channelRepository.channelData.findUnique(channelId));
			this.channels.set(channelId, result);
		}
		return result;
	}

	/** 将依赖读取失败统一转换为服务不可用错误。 */
	private async readDependency<T>(read: () => Promise<T>): Promise<T> {
		// 无法确认分级或偏好时中断请求，不按可见处理。
		try {
			return await read();
		} catch (error) {
			throw new ServiceUnavailableError({
				message: 'NSFW visibility settings are temporarily unavailable',
				cause: error instanceof Error ? error : undefined,
			});
		}
	}
}
