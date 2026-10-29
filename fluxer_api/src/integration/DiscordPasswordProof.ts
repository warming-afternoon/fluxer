// SPDX-License-Identifier: AGPL-3.0-or-later

import {createHash, randomBytes} from 'node:crypto';
import {IntegrationError} from '@app/integration/IntegrationError';
import type {ICacheService} from '@pkgs/cache/src/ICacheService';

interface PasswordProof {
	/** 仅允许初次设置密码 */
	purpose: 'set_initial_password';

	/** 证明绑定的用户 */
	userId: string;

	/** 证明绑定的当前会话 */
	sessionHash: string;

	/** 本次新鲜验证时间 */
	verifiedAt: number;
}

/** 生成短期一次性密码设置证明，调用前必须核验外部身份和当前会话一致 */
export async function issueDiscordPasswordProof(
	cache: ICacheService,
	userId: string,
	sessionHash: string,
	verifiedAt: number,
): Promise<string> {
	// 缓存只保存随机证明的哈希，并绑定用户、当前会话和验证时间。
	const proof = randomBytes(32).toString('base64url');
	const key = `integration:password-proof:${createHash('sha256').update(proof).digest('hex')}`;
	await cache.set(key, {purpose: 'set_initial_password', userId, sessionHash, verifiedAt} satisfies PasswordProof, 120);
	return proof;
}

/** 原生敏感操作消费身份和会话均匹配的一次性证明，MFA 仍由原生流程验证 */
export async function consumeDiscordPasswordProof(
	cache: ICacheService,
	proof: string,
	userId: string,
	sessionHash: string,
): Promise<void> {
	if (!/^[a-zA-Z0-9_-]{43}$/.test(proof)) throw new IntegrationError('INVALID_PROOF', 'Invalid password setup proof');
	const key = `integration:password-proof:${createHash('sha256').update(proof).digest('hex')}`;
	// 原子读取并删除，失败或重复使用均不能再次消费同一证明。
	const stored = await cache.getAndDelete<PasswordProof>(key);
	if (
		stored?.purpose !== 'set_initial_password' ||
		stored.userId !== userId ||
		stored.sessionHash !== sessionHash ||
		Date.now() - stored.verifiedAt > 120_000 ||
		stored.verifiedAt > Date.now() + 30_000
	) {
		throw new IntegrationError('INVALID_PROOF', 'Password setup proof expired or mismatched');
	}
}
