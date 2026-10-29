// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ApiContext} from '@app/api/ApiContext';
import {executeConditional} from '@app/api/database/CassandraQueryExecution';
import {EMPTY_USER_ROW, type UserRow} from '@app/api/database/types/UserTypes';
import type {User} from '@app/api/models/User';
import {UserSettings} from '@app/api/models/UserSettings';
import {UserSettings as UserSettingsTable, Users} from '@app/api/Tables';
import {UserIndexRepository} from '@app/api/user/repositories/account/crud/UserIndexRepository';
import {UserSearchRepository} from '@app/api/user/repositories/account/crud/UserSearchRepository';
import {reserveUsername} from '@app/api/user/UniqueUsernames';
import {USERNAME_MODE_DISCRIMINATOR} from '@app/api/user/UserTag';
import {importDiscordAvatar} from '@app/integration/DiscordAvatarImport';
import {IntegrationError} from '@app/integration/IntegrationError';
import type {DiscordBinding} from '@app/integration/IntegrationIdentityRepository';

export class NativeAccountRepository {
	/** 注入原生服务以复用账号索引和配置 */
	constructor(private readonly context: ApiContext) {}

	/** 条件创建原生账户，并幂等补齐初始化步骤 */
	async initialize(binding: DiscordBinding): Promise<User> {
		const {users, cache} = this.context.services;
		let user = await users.findUnique(binding.user_id);
		const trait = `discord_identity:${binding.discord_user_id}`;
		if (!user) {
			const avatarHash = await importDiscordAvatar(binding);
			const reservation = await reserveUsername({users, cache}, binding.username, binding.user_id);
			try {
				const row: UserRow = {
					...EMPTY_USER_ROW,
					user_id: binding.user_id,
					username: binding.username,
					avatar_hash: avatarHash,
					discriminator: USERNAME_MODE_DISCRIMINATOR,
					global_name: binding.display_name,
					bot: false,
					system: false,
					email: null,
					email_verified: false,
					email_bounced: false,
					flags: 0n,
					has_ever_purchased: false,
					last_active_at: binding.created_at,
					acls: new Set<string>(),
					traits: new Set(['sso', 'discord_integration', trait]),
					version: 1,
				};
				// 条件写入防止并发恢复覆盖任何已存在的原生资料。
				await executeConditional(Users.insertIfNotExists(row));
			} finally {
				await reservation.release();
			}
			user = await users.findUnique(binding.user_id);
		}
		if (!user?.traits.has(trait)) throw new IntegrationError('IDENTITY_CONFLICT', 'Native account ownership mismatch');
		await new UserIndexRepository().syncIndices(user.toRow(), null);
		await new UserSearchRepository().indexUser(user);
		await executeConditional(
			UserSettingsTable.insertIfNotExists(
				UserSettings.getDefaultUserSettings({userId: user.id, locale: 'en-US', isAdult: false}),
			),
		);
		return user;
	}
}
