// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ApiContext} from '@app/api/ApiContext';
import {executeConditional} from '@app/api/database/CassandraQueryExecution';
import {EMPTY_USER_ROW, type UserRow} from '@app/api/database/types/UserTypes';
import type {User} from '@app/api/models/User';
import {UserSettings} from '@app/api/models/UserSettings';
import {UserSettings as UserSettingsTable, Users} from '@app/api/Tables';
import {UserIndexRepository} from '@app/api/user/repositories/account/crud/UserIndexRepository';
import {UserSearchRepository} from '@app/api/user/repositories/account/crud/UserSearchRepository';
import {
	isUsernameTaken,
	isUsernameTakenError,
	reserveUsername,
	type UsernameReservation,
} from '@app/api/user/UniqueUsernames';
import {USERNAME_MODE_DISCRIMINATOR} from '@app/api/user/UserTag';
import {importDiscordAvatar} from '@app/integration/DiscordAvatarImport';
import {discordUsernameCandidate} from '@app/integration/DiscordUsername';
import {IntegrationError} from '@app/integration/IntegrationError';
import type {DiscordBinding} from '@app/integration/IntegrationIdentityRepository';

export class NativeAccountRepository {
	/** 注入原生服务以复用账号索引和配置 */
	constructor(private readonly context: ApiContext) {}

	/** 仅在确认真实重名后选择稳定后缀并预留初始用户名。 */
	private async reserveInitialUsername(binding: DiscordBinding): Promise<UsernameReservation> {
		const {users, cache} = this.context.services;
		for (let attempt = 0; attempt < 20; attempt++) {
			const username = discordUsernameCandidate(binding.username, binding.user_id, attempt);
			try {
				return await reserveUsername({users, cache}, username, binding.user_id);
			} catch (error) {
				if (!isUsernameTakenError(error)) throw error;
				if (!(await isUsernameTaken(users, username, binding.user_id)))
					throw new IntegrationError('BUSY', 'Username reservation is busy; retry account initialization', true);
			}
		}
		throw new IntegrationError('BUSY', 'No available username candidate; retry account initialization', true);
	}

	/** 为已落库账号重新持有当前用户名预留，不覆盖冲突账号。 */
	private async reserveExistingUsername(user: User): Promise<UsernameReservation> {
		const {users, cache} = this.context.services;
		try {
			return await reserveUsername({users, cache}, user.username, user.id);
		} catch (error) {
			if (!isUsernameTakenError(error)) throw error;
			if (await isUsernameTaken(users, user.username, user.id))
				throw new IntegrationError('IDENTITY_CONFLICT', 'Native account username is owned by another account');
			throw new IntegrationError('BUSY', 'Username reservation is busy; retry account initialization', true);
		}
	}

	/** 条件创建原生账户，并幂等补齐初始化步骤 */
	async initialize(binding: DiscordBinding): Promise<User> {
		const {users} = this.context.services;
		const trait = `discord_identity:${binding.discord_user_id}`;
		let initialized: User | null = null;
		let observedUser = false;
		for (let attempt = 0; attempt < 20; attempt++) {
			let user = await users.findUnique(binding.user_id);
			if (!user && observedUser)
				throw new IntegrationError('BOUND_ACCOUNT_MISSING', 'Native account disappeared during initialization');
			if (user && !user.traits.has(trait))
				throw new IntegrationError('IDENTITY_CONFLICT', 'Native account ownership mismatch');
			observedUser ||= user !== null;
			const avatarHash = user ? null : await importDiscordAvatar(binding);
			const reservation = user ? await this.reserveExistingUsername(user) : await this.reserveInitialUsername(binding);
			try {
				// 等待名字锁时同一身份可能已完成创建或改名，不能覆盖它的资料。
				user = await users.findUnique(binding.user_id);
				if (!user) {
					if (observedUser)
						throw new IntegrationError('BOUND_ACCOUNT_MISSING', 'Native account disappeared during initialization');
					const row: UserRow = {
						...EMPTY_USER_ROW,
						user_id: binding.user_id,
						username: reservation.username,
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
					user = await users.findUnique(binding.user_id);
				}
				if (!user?.traits.has(trait))
					throw new IntegrationError('IDENTITY_CONFLICT', 'Native account ownership mismatch');
				observedUser = true;
				// 不同名字必须重新预留，不能持旧名字锁发布已改名账户的索引。
				if (user.username.toLowerCase() !== reservation.username.toLowerCase()) continue;
				if (await isUsernameTaken(users, user.username, user.id))
					throw new IntegrationError('IDENTITY_CONFLICT', 'Native account username is owned by another account');
				// 创建和中断恢复均须先公开原生名字索引，再释放对应名字锁。
				await new UserIndexRepository().syncIndices(user.toRow(), null);
				initialized = user;
				break;
			} finally {
				await reservation.release();
			}
		}
		if (!initialized)
			throw new IntegrationError('BUSY', 'Native account username kept changing; retry initialization', true);
		await new UserSearchRepository().indexUser(initialized);
		await executeConditional(
			UserSettingsTable.insertIfNotExists(
				UserSettings.getDefaultUserSettings({userId: initialized.id, locale: 'en-US', isAdult: false}),
			),
		);
		return initialized;
	}
}
