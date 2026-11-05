// SPDX-License-Identifier: AGPL-3.0-or-later

import {randomUUID} from 'node:crypto';
import {createGuildID, createUserID, type GuildID, type UserID} from '@app/api/BrandedTypes';
import {GatewayRpcClient} from '@app/api/infrastructure/GatewayRpcClient';
import type {IGatewayService} from '@app/api/infrastructure/IGatewayService';
import type {UserGuildSettings} from '@app/api/models/UserGuildSettings';
import {forumNsfwGuildId} from '@app/api/user/NsfwDisplayScope';
import {UserGuildNsfwRepository} from '@app/api/user/repositories/UserGuildNsfwRepository';
import {dispatchUserGuildSettingsUpdate} from '@app/api/user/UserGuildSettingsThreadView';
import {IntegrationError} from '@app/integration/IntegrationError';
import {IntegrationEventJournal} from '@app/integration/IntegrationEventJournal';

/** 协调偏好持久化、网关隔离及可恢复的事件记录。 */
export class NsfwDisplayPreferenceService {
	/** 注入偏好写入及同步所需的依赖。 */
	constructor(
		// 推送原生用户社区设置更新。
		private readonly gateway: IGatewayService,

		// 负责偏好的版本化条件写入。
		private readonly repository = new UserGuildNsfwRepository(),

		// 保留未确认的持久化恢复意图。
		private readonly journal = new IntegrationEventJournal(),

		// 同步最终偏好并隔离旧会话。
		private readonly sync = syncNsfwPreference,

		// 在持久化前建立网关隔离屏障。
		private readonly begin = beginNsfwPreferenceUpdate,
	) {}

	/** 校验并条件更新目标社区偏好，完成同步后才返回。 */
	async update(userId: UserID, guildId: GuildID, show: boolean, expected: number): Promise<UserGuildSettings> {
		if (guildId.toString() !== forumNsfwGuildId())
			throw new IntegrationError('RESOURCE_NOT_ALLOWED', 'Preference is restricted to the configured Forum guild');
		if (
			typeof show !== 'boolean' ||
			!Number.isSafeInteger(expected) ||
			expected < 0 ||
			expected >= Number.MAX_SAFE_INTEGER
		)
			throw new IntegrationError('INVALID_REQUEST', 'Invalid preference value or version');
		const before = await this.repository.get(userId, guildId);
		if (before.nsfwVersion !== expected && !(before.nsfwVersion === expected + 1 && before.showNsfw === show))
			throw new IntegrationError('STALE_VERSION', 'Preference changed; reload before saving');
		// 每次尝试使用独立意图，避免并发重试相互删除待恢复记录。
		const resource = `nsfw:${guildId}:${userId}:${randomUUID()}`;
		await this.journal.track(resource, {
			nsfw_preference: true,
			expected_version: expected,
			show_nsfw: show,
			user_id: userId.toString(),
			guild_id: guildId.toString(),
		});
		let settings: UserGuildSettings;
		try {
			await this.begin(userId, guildId, expected);
			settings = await this.repository.compareAndSet(userId, guildId, show, expected);
		} catch (error) {
			// 已确认的新版本可解除本次旧屏障；无法确认时保留恢复意图。
			try {
				const latest = await this.repository.get(userId, guildId);
				if (latest.nsfwVersion > expected) {
					await this.sync(userId, guildId, latest.showNsfw === true, latest.nsfwVersion);
					await this.journal.completePreferenceIntent(resource);
				}
			} catch {
				// 保留本次未解决的持久化意图，交由恢复流程继续处理。
			}
			throw error;
		}
		await this.sync(userId, guildId, settings.showNsfw === true, settings.nsfwVersion);
		await dispatchUserGuildSettingsUpdate(this.gateway, userId, settings);
		await this.journal.completePreferenceIntent(resource);
		return settings;
	}
}

/** 确认旧会话及其重放缓冲区已隔离后才完成偏好同步。 */
export async function syncNsfwPreference(
	userId: UserID,
	guildId: GuildID,
	show: boolean,
	version: number,
): Promise<void> {
	if (guildId.toString() !== forumNsfwGuildId()) return;
	// 只有网关明确确认同步成功，才能向上层报告完成。
	const response = await GatewayRpcClient.getInstance().call<unknown>('guild.sync_nsfw_preference', {
		guild_id: guildId.toString(),
		user_id: userId.toString(),
		forum_nsfw_guild_id: forumNsfwGuildId(),
		show_nsfw: show,
		nsfw_version: version,
	});
	if (
		response !== true &&
		!(response && typeof response === 'object' && 'success' in response && response.success === true)
	)
		throw new IntegrationError('UNAVAILABLE', 'Gateway preference synchronization is unconfirmed', true);
}

/** 仅重放原始持久化意图，不覆盖更新的原生偏好版本。 */
export async function reconcileNsfwPreference(
	data: Record<string, unknown>,
	resource: string,
	repository = new UserGuildNsfwRepository(),
	journal = new IntegrationEventJournal(),
	begin = beginNsfwPreferenceUpdate,
	sync = syncNsfwPreference,
): Promise<void> {
	const guildId = createGuildID(BigInt(String(data.guild_id)));
	if (guildId.toString() !== forumNsfwGuildId()) return;
	const userId = createUserID(BigInt(String(data.user_id)));
	const expected = data.expected_version;
	const show = data.show_nsfw;
	if (
		typeof expected !== 'number' ||
		!Number.isSafeInteger(expected) ||
		expected < 0 ||
		expected >= Number.MAX_SAFE_INTEGER ||
		typeof show !== 'boolean'
	)
		throw new Error('Invalid durable preference intent');
	// 相同版本才重放写入；已有新版本则以其权威值完成同步。
	let settings = await repository.get(userId, guildId);
	if (settings.nsfwVersion < expected) throw new Error('Preference authority regressed');
	if (settings.nsfwVersion === expected) {
		await begin(userId, guildId, expected);
		settings = await repository.compareAndSet(userId, guildId, show, expected);
	}
	await sync(userId, guildId, settings.showNsfw === true, settings.nsfwVersion);
	await journal.completePreferenceIntent(resource);
}

/** 条件写入前先隔离会话，避免持久化后崩溃导致旧会话继续显示内容。 */
export async function beginNsfwPreferenceUpdate(userId: UserID, guildId: GuildID, expected: number): Promise<void> {
	// 只有屏障得到明确确认，调用方才能继续写入偏好。
	const response = await GatewayRpcClient.getInstance().call<unknown>('guild.begin_nsfw_preference_update', {
		guild_id: guildId.toString(),
		user_id: userId.toString(),
		forum_nsfw_guild_id: forumNsfwGuildId(),
		expected_nsfw_version: expected,
	});
	if (response !== true) throw new IntegrationError('UNAVAILABLE', 'Gateway preference fence is unconfirmed', true);
}
