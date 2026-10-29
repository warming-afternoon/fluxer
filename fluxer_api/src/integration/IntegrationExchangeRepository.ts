// SPDX-License-Identifier: AGPL-3.0-or-later

import {createCipheriv, createDecipheriv, randomBytes} from 'node:crypto';
import type {UserID} from '@app/api/BrandedTypes';
import {IntegrationError} from '@app/integration/IntegrationError';
import {INTEGRATION_QUERY_OPTIONS} from '@app/integration/IntegrationIdentityRepository';
import {getClient} from '@pkgs/cassandra/src/Client';

export interface ExchangeRecord {
	/** 请求指纹 */
	fingerprint: string;

	/** 加密短期返回凭据 */
	encrypted_token: string | null;

	/** 绑定原生用户 */
	user_id: UserID;

	/** 持久化状态 */
	state: string;

	/** 结果过期时间 */
	expires_at: Date;
}

export class IntegrationExchangeRepository {
	/** 验证持久化结果加密密钥 */
	constructor(private readonly key: Buffer) {
		if (key.length !== 32) throw new Error('INTEGRATION_EXCHANGE_KEY must contain 32 bytes');
	}

	/** 永久保留操作指纹，密文单独设置短期过期 */
	async allocate(id: string, fingerprint: string, userId: UserID): Promise<ExchangeRecord> {
		await getClient().execute(
			'INSERT INTO integration_exchanges (exchange_id, fingerprint, user_id, state, expires_at) VALUES (?, ?, ?, ?, ?) IF NOT EXISTS',
			[id, fingerprint, userId, 'allocated', new Date(Date.now() + 600_000)],
			INTEGRATION_QUERY_OPTIONS,
		);
		const record = await this.read(id);
		if (record.fingerprint !== fingerprint || record.user_id !== userId)
			throw new IntegrationError('EXCHANGE_CONFLICT', 'Exchange already belongs to another request');
		if (record.expires_at.getTime() <= Date.now())
			throw new IntegrationError('EXCHANGE_EXPIRED', 'Exchange result expired');
		return record;
	}

	/** 条件提交密文并独占一次原生会话创建尝试 */
	async begin(id: string, token: string): Promise<boolean> {
		// 认证附加数据绑定交换标识，防止密文跨操作复用。
		const iv = randomBytes(12);
		const cipher = createCipheriv('aes-256-gcm', this.key, iv);
		cipher.setAAD(Buffer.from(id));
		const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
		const encrypted = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
		// 只有条件更新的获胜方可以继续创建原生会话。
		const result = await getClient().execute(
			"UPDATE integration_exchanges USING TTL 600 SET encrypted_token = ?, state = 'executing' WHERE exchange_id = ? IF state = 'allocated'",
			[encrypted, id],
			INTEGRATION_QUERY_OPTIONS,
		);
		return result.wasApplied();
	}

	/** 解密与操作绑定的短期结果 */
	decrypt(id: string, record: ExchangeRecord): string {
		if (!record.encrypted_token || record.expires_at.getTime() <= Date.now())
			throw new IntegrationError('EXCHANGE_EXPIRED', 'Exchange result expired');
		const packed = Buffer.from(record.encrypted_token, 'base64url');
		const decipher = createDecipheriv('aes-256-gcm', this.key, packed.subarray(0, 12));
		decipher.setAAD(Buffer.from(id));
		decipher.setAuthTag(packed.subarray(12, 28));
		return Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString('utf8');
	}

	/** 查询权威交换状态 */
	async read(id: string): Promise<ExchangeRecord> {
		const record = await this.find(id);
		if (!record) throw new IntegrationError('STORAGE_UNAVAILABLE', 'Exchange state unavailable', true);
		return record;
	}

	/** 区分新交换与已经验证过的幂等重试 */
	async find(id: string): Promise<ExchangeRecord | null> {
		const result = await getClient().execute(
			'SELECT fingerprint, encrypted_token, user_id, state, expires_at FROM integration_exchanges WHERE exchange_id = ?',
			[id],
			INTEGRATION_QUERY_OPTIONS,
		);
		const record = result.first();
		return record as unknown as ExchangeRecord | null;
	}

	/** 会话持久化后才标记交换完成 */
	async complete(id: string): Promise<void> {
		const result = await getClient().execute(
			"UPDATE integration_exchanges SET state = 'complete' WHERE exchange_id = ? IF state = 'executing'",
			[id],
			INTEGRATION_QUERY_OPTIONS,
		);
		if (!result.wasApplied()) {
			const record = await this.read(id);
			if (record.state !== 'complete' || record.expires_at.getTime() <= Date.now()) {
				throw new IntegrationError('EXCHANGE_UNCERTAIN', 'Exchange completion was not persisted', true);
			}
		}
	}
}
