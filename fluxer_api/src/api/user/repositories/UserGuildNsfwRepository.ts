// SPDX-License-Identifier: AGPL-3.0-or-later

import type {GuildID, UserID} from '@app/api/BrandedTypes';
import {executeConditional} from '@app/api/database/CassandraQueryExecution';
import {Db} from '@app/api/database/CassandraTypes';
import {UserGuildSettings} from '@app/api/models/UserGuildSettings';
import {UserGuildSettings as SettingsTable} from '@app/api/Tables';
import {UserSettingsRepository} from '@app/api/user/repositories/UserSettingsRepository';
import {IntegrationError} from '@app/integration/IntegrationError';

/** 使用独立的轻量事务版本维护 NSFW 偏好，普通通知设置不得覆盖。 */
export class UserGuildNsfwRepository {
	/** 注入原生用户社区设置仓储。 */
	constructor(
		// 读取原生设置，并与普通通知设置共享存储记录。
		private readonly settings = new UserSettingsRepository(),
	) {}

	/** 检查偏好存储所依赖的原生设置读取链路。 */
	async checkHealth(): Promise<void> {
		// 使用保留标识探测存储可用性，不写入用户数据。
		await this.settings.findGuildSettings(0n as UserID, 0n as GuildID);
	}

	/** 读取社区偏好，缺失时返回默认隐藏设置。 */
	async get(userId: UserID, guildId: GuildID): Promise<UserGuildSettings> {
		// 默认值仅在内存中构造，不为读取请求创建数据库记录。
		return (await this.settings.findGuildSettings(userId, guildId)) ?? defaultGuildNsfwSettings(userId, guildId);
	}

	/** 按预期版本条件写入偏好，并兼容相同请求的安全重试。 */
	async compareAndSet(userId: UserID, guildId: GuildID, show: boolean, expected: number): Promise<UserGuildSettings> {
		if (
			!Number.isSafeInteger(expected) ||
			expected < 0 ||
			expected >= Number.MAX_SAFE_INTEGER ||
			typeof show !== 'boolean'
		)
			throw new IntegrationError('INVALID_REQUEST', 'Invalid preference version or value');
		for (let attempt = 0; attempt < 5; attempt++) {
			const stored = await this.settings.findGuildSettings(userId, guildId);
			const current = stored ?? defaultGuildNsfwSettings(userId, guildId);
			// 持久化后的传输失败可使用相同预期版本重试，已生效的相同值直接返回。
			if (current.nsfwVersion === expected + 1 && current.showNsfw === show) return current;
			if (current.nsfwVersion !== expected)
				throw new IntegrationError('STALE_VERSION', 'Preference changed; reload before saving');
			// 首次创建与已有记录更新都采用条件写入，避免覆盖并发修改。
			const applied = await executeConditional(
				stored === null
					? SettingsTable.insertIfNotExists({
							...current.toRow(),
							version: 1,
							show_nsfw: show,
							nsfw_version: BigInt(expected + 1),
						})
					: SettingsTable.conditionalPatchByPk(
							{user_id: userId, guild_id: guildId},
							{show_nsfw: Db.set(show), nsfw_version: Db.set(BigInt(expected + 1))},
							expected === 0 ? {nsfw_version: null, version: current.version} : {nsfw_version: BigInt(expected)},
						),
			);
			if (!applied) {
				const latest = await this.get(userId, guildId);
				if (latest.nsfwVersion === expected + 1 && latest.showNsfw === show) return latest;
				if (latest.nsfwVersion !== expected)
					throw new IntegrationError('STALE_VERSION', 'Preference changed; reload before saving');
				continue;
			}
			// 保留原生通知默认值，NSFW 偏好使用独立的初始版本。
			return new UserGuildSettings({...current.toRow(), show_nsfw: show, nsfw_version: BigInt(expected + 1)});
		}
		throw new IntegrationError('BUSY', 'Settings are changing; retry the same preference version', true);
	}
}

/** 构造尚未持久化的社区设置，默认隐藏 NSFW 内容。 */
export function defaultGuildNsfwSettings(userId: UserID, guildId: GuildID): UserGuildSettings {
	// 保留原生通知默认值，NSFW 偏好使用独立的初始版本。
	return new UserGuildSettings({
		user_id: userId,
		guild_id: guildId,
		message_notifications: null,
		muted: false,
		mute_config: null,
		mobile_push: true,
		suppress_everyone: false,
		suppress_roles: false,
		hide_muted_channels: false,
		channel_overrides: null,
		unread_badges: null,
		version: 0,
		show_nsfw: false,
		nsfw_version: null,
	});
}
