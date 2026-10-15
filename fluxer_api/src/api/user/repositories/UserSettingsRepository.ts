// SPDX-License-Identifier: AGPL-3.0-or-later

import type {GuildID, UserID} from '@app/api/BrandedTypes';
import {deleteOneOrMany, fetchMany, fetchOne} from '@app/api/database/CassandraQueryExecution';
import {buildPatchFromData, executeVersionedUpdate} from '@app/api/database/CassandraVersionedUpdate';
import type {UserGuildSettingsRow, UserSettingsRow} from '@app/api/database/types/UserTypes';
import {USER_GUILD_SETTINGS_COLUMNS, USER_SETTINGS_COLUMNS} from '@app/api/database/types/UserTypes';
import {Logger} from '@app/api/Logger';
import {UserGuildSettings} from '@app/api/models/UserGuildSettings';
import {UserSettings} from '@app/api/models/UserSettings';
import {UserGuildSettings as UserGuildSettingsTable, UserSettings as UserSettingsTable} from '@app/api/Tables';

const FETCH_USER_SETTINGS_CQL = UserSettingsTable.selectCql({
	where: UserSettingsTable.where.eq('user_id'),
	limit: 1,
});
const FETCH_USER_GUILD_SETTINGS_CQL = UserGuildSettingsTable.selectCql({
	where: [UserGuildSettingsTable.where.eq('user_id'), UserGuildSettingsTable.where.eq('guild_id')],
	limit: 1,
});
const FETCH_USER_GUILD_SETTINGS_BATCH_CQL = UserGuildSettingsTable.selectCql({
	where: [UserGuildSettingsTable.where.in('user_id', 'user_ids'), UserGuildSettingsTable.where.eq('guild_id')],
});
const GUILD_SETTINGS_BATCH_SIZE = 200;
const FETCH_ALL_USER_GUILD_SETTINGS_CQL = UserGuildSettingsTable.selectCql({
	where: UserGuildSettingsTable.where.eq('user_id'),
});

export class UserSettingsRepository {
	async deleteAllUserGuildSettings(userId: UserID): Promise<void> {
		await deleteOneOrMany(
			UserGuildSettingsTable.deleteCql({
				where: UserGuildSettingsTable.where.eq('user_id'),
			}),
			{user_id: userId},
		);
	}

	async deleteGuildSettings(userId: UserID, guildId: GuildID): Promise<void> {
		await deleteOneOrMany(
			UserGuildSettingsTable.deleteByPk({
				user_id: userId,
				guild_id: guildId,
			}),
		);
	}

	async deleteUserSettings(userId: UserID): Promise<void> {
		await deleteOneOrMany(UserSettingsTable.deleteByPk({user_id: userId}));
	}

	async findGuildSettings(userId: UserID, guildId: GuildID | null): Promise<UserGuildSettings | null> {
		const settings = await fetchOne<UserGuildSettingsRow>(FETCH_USER_GUILD_SETTINGS_CQL, {
			user_id: userId,
			guild_id: guildId ? guildId : 0n,
		});
		return settings ? new UserGuildSettings(settings) : null;
	}

	/** 顺序批查完整主键，并还原输入顺序、重复项及缺失设置 */
	async findGuildSettingsBatch(
		userIds: Array<UserID>,
		guildId: GuildID | null,
	): Promise<Array<UserGuildSettings | null>> {
		if (userIds.length === 0) return [];
		const uniqueIds = [...new Set(userIds)];
		const settingsByUser = new Map<UserID, UserGuildSettings>();
		// 去重后的完整主键每批最多两百个，不增加连接池或并行查询。
		for (let offset = 0; offset < uniqueIds.length; offset += GUILD_SETTINGS_BATCH_SIZE) {
			const rows = await fetchMany<UserGuildSettingsRow>(FETCH_USER_GUILD_SETTINGS_BATCH_CQL, {
				user_ids: uniqueIds.slice(offset, offset + GUILD_SETTINGS_BATCH_SIZE),
				guild_id: guildId ?? 0n,
			});
			for (const row of rows) settingsByUser.set(row.user_id, new UserGuildSettings(row));
		}
		// RPC 调用方按输入下标匹配用户，不能直接使用数据库返回顺序。
		return userIds.map((userId) => settingsByUser.get(userId) ?? null);
	}

	async findAllGuildSettings(userId: UserID): Promise<Array<UserGuildSettings>> {
		const rows = await fetchMany<UserGuildSettingsRow>(FETCH_ALL_USER_GUILD_SETTINGS_CQL, {
			user_id: userId,
		});
		return rows.map((row) => new UserGuildSettings(row));
	}

	async findSettings(userId: UserID): Promise<UserSettings | null> {
		const settings = await fetchOne<UserSettingsRow>(FETCH_USER_SETTINGS_CQL, {user_id: userId});
		return settings ? new UserSettings(settings) : null;
	}

	async upsertGuildSettings(settings: UserGuildSettingsRow): Promise<UserGuildSettings> {
		const userId = settings.user_id;
		const guildId = settings.guild_id;
		const result = await executeVersionedUpdate<UserGuildSettingsRow, 'user_id' | 'guild_id'>(
			() =>
				this.findGuildSettings(userId, guildId)
					.then((s) => s?.toRow() ?? null)
					.catch((error) => {
						Logger.error(
							{userId: userId.toString(), guildId: guildId.toString(), error},
							'Failed to fetch guild settings',
						);
						throw error;
					}),
			(current) => ({
				pk: {user_id: userId, guild_id: guildId},
				patch: buildPatchFromData(settings, current, USER_GUILD_SETTINGS_COLUMNS, ['user_id', 'guild_id']),
			}),
			UserGuildSettingsTable,
		);
		return new UserGuildSettings({...settings, version: result.finalVersion ?? 1});
	}

	async upsertSettings(settings: UserSettingsRow): Promise<UserSettings> {
		const userId = settings.user_id;
		const result = await executeVersionedUpdate<UserSettingsRow, 'user_id'>(
			() =>
				this.findSettings(userId)
					.then((s) => s?.toRow() ?? null)
					.catch((error) => {
						Logger.error({userId: userId.toString(), error}, 'Failed to fetch settings');
						throw error;
					}),
			(current) => ({
				pk: {user_id: userId},
				patch: buildPatchFromData(settings, current, USER_SETTINGS_COLUMNS, ['user_id']),
			}),
			UserSettingsTable,
		);
		return new UserSettings({...settings, version: result.finalVersion ?? 1});
	}
}
