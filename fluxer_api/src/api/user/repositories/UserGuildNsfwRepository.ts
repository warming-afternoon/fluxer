// SPDX-License-Identifier: AGPL-3.0-or-later

import type {GuildID, UserID} from '@app/api/BrandedTypes';
import {executeConditional} from '@app/api/database/CassandraQueryExecution';
import {Db} from '@app/api/database/CassandraTypes';
import {UserGuildSettings} from '@app/api/models/UserGuildSettings';
import {UserGuildSettings as SettingsTable} from '@app/api/Tables';
import {UserSettingsRepository} from '@app/api/user/repositories/UserSettingsRepository';
import {IntegrationError} from '@app/integration/IntegrationError';

/** The NSFW pair has its own LWT version. Ordinary notification writes never write it. */
export class UserGuildNsfwRepository {
	constructor(private readonly settings = new UserSettingsRepository()) {}

	async checkHealth(): Promise<void> {
		await this.settings.findGuildSettings(0n as UserID, 0n as GuildID);
	}

	async get(userId: UserID, guildId: GuildID): Promise<UserGuildSettings> {
		return (await this.settings.findGuildSettings(userId, guildId)) ?? defaultGuildNsfwSettings(userId, guildId);
	}

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
			// A transport failure after persistence is retried using the same expected value.
			if (current.nsfwVersion === expected + 1 && current.showNsfw === show) return current;
			if (current.nsfwVersion !== expected)
				throw new IntegrationError('STALE_VERSION', 'Preference changed; reload before saving');
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
			return new UserGuildSettings({...current.toRow(), show_nsfw: show, nsfw_version: BigInt(expected + 1)});
		}
		throw new IntegrationError('BUSY', 'Settings are changing; retry the same preference version', true);
	}
}

export function defaultGuildNsfwSettings(userId: UserID, guildId: GuildID): UserGuildSettings {
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
