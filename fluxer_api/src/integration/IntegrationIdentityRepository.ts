// SPDX-License-Identifier: AGPL-3.0-or-later

import type {UserID} from '@app/api/BrandedTypes';
import {IntegrationError} from '@app/integration/IntegrationError';
import type {DiscordProfile} from '@app/integration/IntegrationSchemas';
import {getClient} from '@pkgs/cassandra/src/Client';
import cassandra from 'cassandra-driver';

export interface DiscordBinding {
	/** Discord 主体 */
	discord_user_id: string;

	/** 原生账户主键 */
	user_id: UserID;

	/** 首次创建操作 */
	operation_id: string;

	/** 初始用户名 */
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
			'SELECT discord_user_id FROM integration_user_identities WHERE user_id = ?',
			[userId],
			INTEGRATION_QUERY_OPTIONS,
		);
		const discordId = result.first()?.discord_user_id as string | undefined;
		if (!discordId) return null;
		const binding = await this.find(discordId);
		if (binding?.state !== 'ready' || binding.user_id !== userId)
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
	): Promise<DiscordBinding> {
		await getClient().execute(
			'INSERT INTO integration_discord_identities (discord_user_id, user_id, operation_id, username, display_name, avatar_url, state, version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) IF NOT EXISTS',
			[discordId, userId, operationId, username, profile.display_name, profile.avatar_url, 'pending', 1, new Date()],
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
