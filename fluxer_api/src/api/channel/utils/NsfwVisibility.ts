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

/** The integration display preference has no meaning outside its explicitly configured guild. */
export function isNsfwVisibilityGuild(guildId: GuildID | null): boolean {
	return guildId !== null && guildId.toString() === forumNsfwGuildId();
}

/** One request only: never retain a user's preference between HTTP requests or depend on a live session. */
export class NsfwVisibility {
	private readonly preferences = new Map<GuildID, Promise<boolean>>();
	private readonly guildNsfw = new Map<GuildID, Promise<boolean>>();
	private readonly channels = new Map<ChannelID, Promise<Channel | null>>();

	constructor(
		private readonly userId: UserID,
		private readonly channelRepository: Pick<ChannelRepository, 'channelData'>,
		private readonly guildRepository: Pick<GuildRepository, 'findUnique'> = new GuildRepository(),
		private readonly settingsRepository: Pick<
			UserSettingsRepository,
			'findGuildSettings'
		> = new UserSettingsRepository(),
	) {}

	/** New classification reads must fail as an unavailable dependency, never bypass filtering. */
	async readChannels(channelIds: Array<ChannelID>): Promise<Array<Channel>> {
		return this.readDependency(() => this.channelRepository.channelData.listChannels(channelIds));
	}

	async assertVisible(channel: Channel): Promise<void> {
		if (!(await this.isVisible(channel))) throw new UnknownChannelError();
	}

	async filter(channels: ReadonlyArray<Channel>): Promise<Array<Channel>> {
		for (const channel of channels) this.channels.set(channel.id, Promise.resolve(channel));
		const visible = await Promise.all(channels.map((channel) => this.isVisible(channel)));
		return channels.filter((_, index) => visible[index]);
	}

	async isVisible(channel: Channel): Promise<boolean> {
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

	private findChannel(channelId: ChannelID): Promise<Channel | null> {
		let result = this.channels.get(channelId);
		if (!result) {
			result = this.readDependency(() => this.channelRepository.channelData.findUnique(channelId));
			this.channels.set(channelId, result);
		}
		return result;
	}

	private async readDependency<T>(read: () => Promise<T>): Promise<T> {
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
