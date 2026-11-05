// SPDX-License-Identifier: AGPL-3.0-or-later

import type {UserID} from '@app/api/BrandedTypes';
import {readSafeIntegerVersion} from '@app/api/database/CassandraVersion';
import {IntegrationError} from '@app/integration/IntegrationError';
import type {DiscordProfile} from '@app/integration/IntegrationSchemas';
import {getClient} from '@pkgs/cassandra/src/Client';
import cassandra from 'cassandra-driver';

export interface DiscordBinding {
	/** Discord 主体 */
	discord_user_id: string;

	/** 原生账户主键 */
	user_id: UserID;

	/** 首次占用身份时固定的创建来源，历史空值不授予入群资格。 */
	creation_source?: 'forum' | 'other' | null;

	/** 首次创建时固定的论坛服务器标识。 */
	creation_guild_id?: string | null;

	/** 首次创建操作 */
	operation_id: string;

	/** 首次首选用户名；确认重名后的实际名字以原生账户为准 */
	username: string;

	/** 初始昵称 */
	display_name: string | null;

	/** 初始 Discord 头像 */
	avatar_url: string | null;

	/** 可恢复创建状态 */
	state: 'pending' | 'ready';

	/** 单调版本 */
	version: number;

	/** 创建时间 */
	created_at: Date;
}

export const INTEGRATION_QUERY_OPTIONS = {
	prepare: true,
	consistency: cassandra.types.consistencies.localQuorum,
	serialConsistency: cassandra.types.consistencies.localSerial,
};

export class IntegrationIdentityRepository {
	/** 沿仅向规范账户的历史映射解析稳定用户，拒绝循环和过长链 */
	async canonicalUserId(userId: UserID): Promise<UserID> {
		const visited = new Set<UserID>();
		let current = userId;
		for (let depth = 0; depth < 16; depth++) {
			if (visited.has(current)) throw new IntegrationError('IDENTITY_CONFLICT', 'Identity merge cycle');
			visited.add(current);
			const response = await getClient().execute(
				'SELECT canonical_user_id FROM integration_user_identities WHERE user_id = ?',
				[current],
				INTEGRATION_QUERY_OPTIONS,
			);
			const canonical = response.first()?.canonical_user_id as UserID | undefined;
			if (!canonical || canonical === current) return current;
			current = canonical;
		}
		throw new IntegrationError('IDENTITY_CONFLICT', 'Identity merge chain exceeds limit');
	}

	/** 独占账户绑定变更，同一操作可以恢复，其他操作必须等待 */
	async lockRebind(userId: UserID, operationId: string): Promise<void> {
		await getClient().execute(
			'UPDATE integration_user_identities SET rebind_operation = ? WHERE user_id = ? IF rebind_operation = null',
			[operationId, userId],
			INTEGRATION_QUERY_OPTIONS,
		);
		const response = await getClient().execute(
			'SELECT rebind_operation FROM integration_user_identities WHERE user_id = ?',
			[userId],
			INTEGRATION_QUERY_OPTIONS,
		);
		if (response.first()?.rebind_operation !== operationId)
			throw new IntegrationError('IDENTITY_BUSY', 'Another identity operation is in progress', true);
	}

	/** 保留原始 Discord 归属，通过规范用户投影合并预建账户 */
	async mergeUser(source: UserID, target: UserID, operationId: string): Promise<void> {
		const result = await getClient().execute(
			'UPDATE integration_user_identities SET canonical_user_id = ? WHERE user_id = ? IF rebind_operation = ?',
			[target, source, operationId],
			INTEGRATION_QUERY_OPTIONS,
		);
		if (!result.wasApplied()) throw new IntegrationError('IDENTITY_CONFLICT', 'Merge ownership mismatch');
	}

	/** 提交当前登录主体并写入历史，锁由完成步骤单独释放 */
	async setCurrent(userId: UserID, discordId: string, operationId: string, version: number): Promise<number> {
		const requestedVersion = readSafeIntegerVersion(version);
		const current = await getClient().execute(
			'SELECT binding_version, binding_operation FROM integration_user_identities WHERE user_id = ?',
			[userId],
			INTEGRATION_QUERY_OPTIONS,
		);
		const row = current.first();
		if (row?.binding_operation === operationId) return readSafeIntegerVersion(row.binding_version);
		const previous = readSafeIntegerVersion(row?.binding_version ?? 1);
		const nextVersion = readSafeIntegerVersion(Math.max(requestedVersion, previous + 1));
		const result = await getClient().execute(
			'UPDATE integration_user_identities SET discord_user_id = ?, binding_version = ?, binding_operation = ? WHERE user_id = ? IF rebind_operation = ?',
			[discordId, BigInt(nextVersion), operationId, userId, operationId],
			INTEGRATION_QUERY_OPTIONS,
		);
		if (!result.wasApplied()) throw new IntegrationError('IDENTITY_CONFLICT', 'Binding ownership mismatch');
		return nextVersion;
	}

	/** 在持锁恢复期间读取当前主体，拒绝旧计划覆盖已完成的后继管理操作 */
	async currentDuringRebind(userId: UserID, operationId: string): Promise<string | null> {
		const result = await getClient().execute(
			'SELECT discord_user_id, rebind_operation FROM integration_user_identities WHERE user_id = ?',
			[userId],
			INTEGRATION_QUERY_OPTIONS,
		);
		if (result.first()?.rebind_operation !== operationId)
			throw new IntegrationError('IDENTITY_CONFLICT', 'Binding ownership mismatch');
		return result.first()?.discord_user_id ?? null;
	}

	/** 规范账户的单调绑定版本使历史身份投影也随管理换绑失效 */
	async bindingVersion(userId: UserID): Promise<number> {
		const result = await getClient().execute(
			'SELECT binding_version FROM integration_user_identities WHERE user_id = ?',
			[userId],
			INTEGRATION_QUERY_OPTIONS,
		);
		return readSafeIntegerVersion(result.first()?.binding_version ?? 1);
	}

	/** 仅由持锁操作释放账户变更门禁 */
	async unlockRebind(userId: UserID, operationId: string): Promise<void> {
		await getClient().execute(
			'UPDATE integration_user_identities SET rebind_operation = null WHERE user_id = ? IF rebind_operation = ?',
			[userId, operationId],
			INTEGRATION_QUERY_OPTIONS,
		);
	}
	/** 在固定批次内读取多个身份分区，避免串行逐个查询 */
	async findMany(discordIds: Array<string>): Promise<Array<DiscordBinding>> {
		if (discordIds.length === 0) return [];
		if (discordIds.length > 100) throw new IntegrationError('INVALID_REQUEST', 'Identity lookup batch exceeds limit');
		const result = await getClient().execute(
			'SELECT * FROM integration_discord_identities WHERE discord_user_id IN ?',
			[discordIds],
			INTEGRATION_QUERY_OPTIONS,
		);
		return result.rows as unknown as Array<DiscordBinding>;
	}

	/** 验证新增表已安装且权威存储可访问 */
	async checkHealth(): Promise<void> {
		await getClient().execute(
			'SELECT creation_source, creation_guild_id FROM integration_discord_identities WHERE discord_user_id = ?',
			['__readiness__'],
			INTEGRATION_QUERY_OPTIONS,
		);
		await getClient().execute(
			'SELECT canonical_user_id, rebind_operation, binding_version, binding_operation FROM integration_user_identities WHERE user_id = ?',
			[1n],
			INTEGRATION_QUERY_OPTIONS,
		);
		await getClient().execute(
			'SELECT resource_owner, payload, result FROM integration_operations WHERE operation_id = ?',
			['__readiness__'],
			INTEGRATION_QUERY_OPTIONS,
		);
		if (process.env.FLUXER_THREAD_POLICY_ENABLED === 'true')
			await getClient().execute(
				'SELECT source FROM thread_external_policies WHERE thread_id = ?',
				[1n],
				INTEGRATION_QUERY_OPTIONS,
			);
		if (process.env.FLUXER_THREAD_POLICY_ENABLED === 'true')
			await getClient().execute(
				'SELECT native_locked, native_archived, external_locked FROM thread_state WHERE thread_id = ?',
				[1n],
				INTEGRATION_QUERY_OPTIONS,
			);
		await getClient().execute(
			'SELECT discord_user_id FROM integration_discord_identities WHERE discord_user_id = ?',
			['__readiness__'],
			INTEGRATION_QUERY_OPTIONS,
		);
		await getClient().execute(
			'SELECT user_id FROM integration_user_identities WHERE user_id = ?',
			[1n],
			INTEGRATION_QUERY_OPTIONS,
		);
		await getClient().execute(
			'SELECT version FROM integration_identity_history WHERE discord_user_id = ? LIMIT 1',
			['__readiness__'],
			INTEGRATION_QUERY_OPTIONS,
		);
		await getClient().execute(
			'SELECT exchange_id FROM integration_exchanges WHERE exchange_id = ?',
			['__readiness__'],
			INTEGRATION_QUERY_OPTIONS,
		);
	}

	/** 读取并双向核对原生用户对应的 Discord 主体 */
	async findDiscordId(userId: UserID): Promise<string | null> {
		const result = await getClient().execute(
			'SELECT discord_user_id, rebind_operation, canonical_user_id FROM integration_user_identities WHERE user_id = ?',
			[userId],
			INTEGRATION_QUERY_OPTIONS,
		);
		const discordId = result.first()?.discord_user_id as string | undefined;
		if (!discordId) return null;
		if (result.first()?.rebind_operation)
			throw new IntegrationError('IDENTITY_BUSY', 'Identity change is in progress', true);
		if (result.first()?.canonical_user_id) throw new IntegrationError('ACCOUNT_UNAVAILABLE', 'Account was merged');
		const binding = await this.find(discordId);
		if (binding?.state !== 'ready' || (await this.canonicalUserId(binding.user_id)) !== userId)
			throw new IntegrationError('IDENTITY_CONFLICT', 'Identity ownership conflicts');
		return discordId;
	}

	/** 按主体读取唯一绑定 */
	async find(discordId: string): Promise<DiscordBinding | null> {
		const result = await getClient().execute(
			'SELECT * FROM integration_discord_identities WHERE discord_user_id = ?',
			[discordId],
			INTEGRATION_QUERY_OPTIONS,
		);
		return result.first() as unknown as DiscordBinding | null;
	}

	/** 条件占用两侧身份，未完成的正向占用供后续请求恢复 */
	async claim(
		discordId: string,
		userId: UserID,
		operationId: string,
		profile: DiscordProfile,
		username: string,
		creation: {source: 'forum' | 'other'; guildId: string | null} = {source: 'other', guildId: null},
	): Promise<DiscordBinding> {
		await getClient().execute(
			'INSERT INTO integration_discord_identities (discord_user_id, user_id, operation_id, username, display_name, avatar_url, state, version, created_at, creation_source, creation_guild_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) IF NOT EXISTS',
			[
				discordId,
				userId,
				operationId,
				username,
				profile.display_name,
				profile.avatar_url,
				'pending',
				1,
				new Date(),
				creation.source,
				creation.guildId,
			],
			INTEGRATION_QUERY_OPTIONS,
		);
		const binding = await this.find(discordId);
		if (!binding) throw new IntegrationError('STORAGE_UNAVAILABLE', 'Identity claim unavailable', true);
		await this.ensureReverse(binding);
		return binding;
	}

	/** 幂等恢复反向占用并拒绝身份冲突 */
	async ensureReverse(binding: DiscordBinding): Promise<void> {
		await getClient().execute(
			'INSERT INTO integration_user_identities (user_id, discord_user_id) VALUES (?, ?) IF NOT EXISTS',
			[binding.user_id, binding.discord_user_id],
			INTEGRATION_QUERY_OPTIONS,
		);
		const result = await getClient().execute(
			'SELECT discord_user_id FROM integration_user_identities WHERE user_id = ?',
			[binding.user_id],
			INTEGRATION_QUERY_OPTIONS,
		);
		if (result.first()?.discord_user_id !== binding.discord_user_id)
			throw new IntegrationError('IDENTITY_CONFLICT', 'Identity ownership conflicts');
	}

	/** 先持久化审计，再提交已完成状态 */
	async complete(binding: DiscordBinding): Promise<void> {
		await getClient().execute(
			'INSERT INTO integration_identity_history (discord_user_id, version, user_id, operation_id, occurred_at) VALUES (?, ?, ?, ?, ?) IF NOT EXISTS',
			[binding.discord_user_id, binding.version, binding.user_id, binding.operation_id, binding.created_at],
			INTEGRATION_QUERY_OPTIONS,
		);
		const result = await getClient().execute(
			"UPDATE integration_discord_identities SET state = 'ready' WHERE discord_user_id = ? IF user_id = ?",
			[binding.discord_user_id, binding.user_id],
			INTEGRATION_QUERY_OPTIONS,
		);
		if (!result.wasApplied()) throw new IntegrationError('IDENTITY_CONFLICT', 'Identity completion ownership mismatch');
	}
}
