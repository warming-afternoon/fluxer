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

export class NsfwDisplayPreferenceService {
	constructor(
		private readonly gateway: IGatewayService,
		private readonly repository = new UserGuildNsfwRepository(),
		private readonly journal = new IntegrationEventJournal(),
		private readonly sync = syncNsfwPreference,
		private readonly begin = beginNsfwPreferenceUpdate,
	) {}

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
		// A unique intent per attempt prevents concurrent retries from deleting each other's work.
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
			// A newer winner can safely release this attempt's lower fence. Uncertainty retains the intent.
			try {
				const latest = await this.repository.get(userId, guildId);
				if (latest.nsfwVersion > expected) {
					await this.sync(userId, guildId, latest.showNsfw === true, latest.nsfwVersion);
					await this.journal.completePreferenceIntent(resource);
				}
			} catch {
				/* Durable recovery retains the exact unresolved attempt. */
			}
			throw error;
		}
		await this.sync(userId, guildId, settings.showNsfw === true, settings.nsfwVersion);
		await dispatchUserGuildSettingsUpdate(this.gateway, userId, settings);
		await this.journal.completePreferenceIntent(resource);
		return settings;
	}
}

/** Confirmation is returned only once old sessions and their replay buffers are fenced. */
export async function syncNsfwPreference(
	userId: UserID,
	guildId: GuildID,
	show: boolean,
	version: number,
): Promise<void> {
	if (guildId.toString() !== forumNsfwGuildId()) return;
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

/** Reapply only the exact durable intent. A newer native version is never overwritten. */
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
	let settings = await repository.get(userId, guildId);
	if (settings.nsfwVersion < expected) throw new Error('Preference authority regressed');
	if (settings.nsfwVersion === expected) {
		await begin(userId, guildId, expected);
		settings = await repository.compareAndSet(userId, guildId, show, expected);
	}
	await sync(userId, guildId, settings.showNsfw === true, settings.nsfwVersion);
	await journal.completePreferenceIntent(resource);
}

/** Fence before CAS so a crash after persistence cannot leave old sessions displaying content. */
export async function beginNsfwPreferenceUpdate(userId: UserID, guildId: GuildID, expected: number): Promise<void> {
	const response = await GatewayRpcClient.getInstance().call<unknown>('guild.begin_nsfw_preference_update', {
		guild_id: guildId.toString(),
		user_id: userId.toString(),
		forum_nsfw_guild_id: forumNsfwGuildId(),
		expected_nsfw_version: expected,
	});
	if (response !== true) throw new IntegrationError('UNAVAILABLE', 'Gateway preference fence is unconfirmed', true);
}
