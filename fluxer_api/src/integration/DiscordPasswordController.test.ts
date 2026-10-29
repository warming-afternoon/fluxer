// SPDX-License-Identifier: AGPL-3.0-or-later

import {createHash} from 'node:crypto';
import * as AuthSession from '@app/api/auth/AuthSession';
import {
	createAuthHarness,
	createTestAccount,
	createTotpSecret,
	type TestAccount,
	totpCodeNow,
} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID} from '@app/api/BrandedTypes';
import {createApiContext} from '@app/api/CreateApiContext';
import {deleteOneOrMany} from '@app/api/database/CassandraQueryExecution';
import {AuthSessions} from '@app/api/Tables';
import type {ApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {issueDiscordPasswordProof} from '@app/integration/DiscordPasswordProof';
import {UserAuthenticatorTypes} from '@fluxer/constants/src/UserConstants';
import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@app/api/infrastructure/APIReadiness', () => ({
	startAPIReadiness: vi.fn(),
	stopAPIReadiness: vi.fn(),
	apiReady: () => true,
}));

/** 将原生测试账户转为无密码 Discord 集成账户 */
async function prepareDiscordAccount(harness: ApiTestHarness): Promise<TestAccount> {
	const account = await createTestAccount(harness);
	const context = createApiContext();
	const id = createUserID(BigInt(account.userId));
	const user = await context.services.users.findUnique(id);
	await context.services.users.patchUpsert(
		id,
		{password_hash: null, email: null, email_verified: false, traits: new Set(['sso', 'discord_integration'])},
		user!.toRow(),
	);
	const prepared = await context.services.users.findUnique(id);
	const [token] = await AuthSession.createAuthSession(context, {
		user: prepared!,
		origin: {ip: '127.0.0.1', userAgent: 'integration-test', clientOs: 'test'},
		authMethod: 'sso',
	});
	return {...account, token};
}

/** 颁发绑定当前原生会话的一次性凭据 */
async function proofFor(account: TestAccount, verifiedAt = Date.now()): Promise<string> {
	const context = createApiContext();
	const hash = createHash('sha256').update(account.token).digest('base64url');
	return issueDiscordPasswordProof(context.services.cache, account.userId, hash, verifiedAt);
}

describe('Discord initial password route', () => {
	let harness: ApiTestHarness;
	beforeAll(async () => {
		vi.stubEnv('INTEGRATION_NATS_URL', 'nats://integration.test:4222');
		try {
			harness = await createAuthHarness();
		} finally {
			vi.unstubAllEnvs();
		}
	});
	beforeEach(async () => {
		await harness.reset();
	});
	afterAll(async () => {
		await harness?.shutdown();
	});
	const password = 'Unique-new-password-1948A!';

	it('sets the first native password and rotates the session', async () => {
		const account = await prepareDiscordAccount(harness);
		const proof = await proofFor(account);
		const response = await createBuilder<{token: string}>(harness, account.token)
			.post('/users/@me/discord-password')
			.body({proof, new_password: password})
			.execute();
		expect(response.token).not.toBe(account.token);
		await createBuilder(harness, account.token).get('/users/@me').expect(401).execute();
		await createBuilder(harness, response.token).get('/users/@me').expect(200).execute();
		const user = await createApiContext().services.users.findUnique(createUserID(BigInt(account.userId)));
		expect(user?.passwordHash).toBeTruthy();
		await createBuilder(harness, response.token)
			.post('/users/@me/discord-password')
			.body({proof, new_password: password})
			.expect(400)
			.execute();
	});

	it('rejects expired and mismatched identity proofs without changing the password', async () => {
		const account = await prepareDiscordAccount(harness);
		const other = await prepareDiscordAccount(harness);
		for (const proof of [await proofFor(account, Date.now() - 121_000), await proofFor(other)]) {
			await createBuilder(harness, account.token)
				.post('/users/@me/discord-password')
				.body({proof, new_password: password})
				.expect(400)
				.execute();
		}
		expect(
			(await createApiContext().services.users.findUnique(createUserID(BigInt(account.userId))))?.passwordHash,
		).toBeNull();
	});

	it('rejects a revoked native session even when the middleware cache is warm', async () => {
		const account = await prepareDiscordAccount(harness);
		const proof = await proofFor(account);
		await createBuilder(harness, account.token).get('/users/@me').expect(200).execute();
		await deleteOneOrMany(
			AuthSessions.deleteByPk({session_id_hash: createHash('sha256').update(account.token).digest()}),
		);
		await createBuilder(harness, account.token)
			.post('/users/@me/discord-password')
			.body({proof, new_password: password})
			.expect(401)
			.execute();
		expect(
			(await createApiContext().services.users.findUnique(createUserID(BigInt(account.userId))))?.passwordHash,
		).toBeNull();
	});

	it('preserves enrolled MFA and consumes the same proof only after a valid challenge', async () => {
		const account = await prepareDiscordAccount(harness);
		const context = createApiContext();
		const id = createUserID(BigInt(account.userId));
		const user = await context.services.users.findUnique(id);
		const secret = createTotpSecret();
		await context.services.users.patchUpsert(
			id,
			{totp_secret: secret, authenticator_types: new Set([UserAuthenticatorTypes.TOTP])},
			user!.toRow(),
		);
		const proof = await proofFor(account);
		await createBuilder(harness, account.token)
			.post('/users/@me/discord-password')
			.body({proof, new_password: password})
			.expect(403, 'SUDO_MODE_REQUIRED')
			.execute();
		await createBuilder(harness, account.token)
			.post('/users/@me/discord-password')
			.body({proof, new_password: password, mfa_method: 'totp', mfa_code: totpCodeNow(secret)})
			.expect(200)
			.execute();
	});

	it('does not grant password setup to ordinary SSO accounts', async () => {
		const account = await prepareDiscordAccount(harness);
		const context = createApiContext();
		const id = createUserID(BigInt(account.userId));
		const user = await context.services.users.findUnique(id);
		await context.services.users.patchUpsert(id, {traits: new Set(['sso'])}, user!.toRow());
		await createBuilder(harness, account.token)
			.post('/users/@me/discord-password')
			.body({proof: await proofFor(account), new_password: password})
			.expect(400)
			.execute();
		await createBuilder(harness, account.token)
			.post('/users/@me/password')
			.body({new_password: password})
			.expect(400)
			.execute();
	});
});
