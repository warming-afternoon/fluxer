// SPDX-License-Identifier: AGPL-3.0-or-later

import {createHash} from 'node:crypto';
import * as AuthSession from '@app/api/auth/AuthSession';
import {createAuthHarness, createTestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID, type UserID} from '@app/api/BrandedTypes';
import {createApiContext} from '@app/api/CreateApiContext';
import {BatchBuilder, deleteOneOrMany} from '@app/api/database/CassandraQueryExecution';
import {AuthSession as AuthSessionModel} from '@app/api/models/AuthSession';
import {AuthSessions} from '@app/api/Tables';
import type {ApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {AuthSessionRepository} from '@app/api/user/repositories/auth/AuthSessionRepository';
import {DiscordAccountService} from '@app/integration/DiscordAccountService';
import * as IntegrationEvents from '@app/integration/IntegrationEvents';
import {type ExchangeRecord, IntegrationExchangeRepository} from '@app/integration/IntegrationExchangeRepository';
import {type DiscordBinding, IntegrationIdentityRepository} from '@app/integration/IntegrationIdentityRepository';
import type {DiscordProfile} from '@app/integration/IntegrationSchemas';
import {IntegrationSchemas} from '@app/integration/IntegrationSchemas';
import {IntegrationService} from '@app/integration/IntegrationService';
import {UserFlags} from '@fluxer/constants/src/UserConstants';
import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@app/api/infrastructure/APIReadiness', () => ({
	startAPIReadiness: vi.fn(),
	stopAPIReadiness: vi.fn(),
	apiReady: () => true,
}));

class MemoryIdentities extends IntegrationIdentityRepository {
	bindings = new Map<string, DiscordBinding>();
	reverse = new Map<UserID, string>();
	failReverseOnce = false;
	failCompleteOnce = false;

	/** 无合并测试中的规范账户保持原 ID */
	override async canonicalUserId(id: UserID): Promise<UserID> {
		return id;
	}

	/** 初始绑定版本未发生管理换绑 */
	override async bindingVersion(): Promise<number> {
		return 1;
	}

	/** 模拟每主体条件占用 */
	override async claim(
		id: string,
		userId: UserID,
		operation: string,
		profile: DiscordProfile,
		username: string,
	): Promise<DiscordBinding> {
		if (!this.bindings.has(id))
			this.bindings.set(id, {
				discord_user_id: id,
				user_id: userId,
				operation_id: operation,
				username,
				display_name: profile.display_name,
				avatar_url: profile.avatar_url,
				state: 'pending',
				version: 1,
				created_at: new Date(),
			});
		const binding = this.bindings.get(id)!;
		await this.ensureReverse(binding);
		return {...binding};
	}

	/** 模拟权威读取 */
	override async find(id: string): Promise<DiscordBinding | null> {
		const binding = this.bindings.get(id);
		return binding ? {...binding} : null;
	}

	/** 模拟反向条件占用和崩溃 */
	override async ensureReverse(binding: DiscordBinding): Promise<void> {
		if (this.failReverseOnce) {
			this.failReverseOnce = false;
			throw new Error('crash');
		}
		const existing = this.reverse.get(binding.user_id);
		if (existing && existing !== binding.discord_user_id) throw new Error('conflict');
		this.reverse.set(binding.user_id, binding.discord_user_id);
	}

	/** 模拟创建后提交前中断 */
	override async complete(binding: DiscordBinding): Promise<void> {
		if (this.failCompleteOnce) {
			this.failCompleteOnce = false;
			throw new Error('crash');
		}
		this.bindings.get(binding.discord_user_id)!.state = 'ready';
	}
}

describe('Integration native authority', () => {
	let harness: ApiTestHarness;
	beforeAll(async () => {
		harness = await createAuthHarness();
	});
	beforeEach(async () => {
		await harness.reset();
		vi.restoreAllMocks();
		vi.spyOn(IntegrationIdentityRepository.prototype, 'findDiscordId').mockResolvedValue('123456789012345678');
	});
	afterAll(async () => {
		await harness?.shutdown();
	});
	const profile = {username: 'discord-name', display_name: 'Discord Name', avatar_url: null};
	const operation = 'operation_123456789';

	it('concurrent Bot and Forum provisioning converge on one initialized native account', async () => {
		const published = vi.spyOn(IntegrationEvents, 'publishIntegrationEvent').mockResolvedValue();
		const context = createApiContext();
		const identities = new MemoryIdentities();
		const bot = new DiscordAccountService(context, identities);
		const forum = new DiscordAccountService(context, identities);
		const results = await Promise.all(
			Array.from({length: 8}, (_, index) =>
				(index % 2 ? bot : forum).ensureDiscordAccount('123456789012345678', profile, `${operation}${index}`),
			),
		);
		expect(new Set(results.map((result) => result.user.id)).size).toBe(1);
		expect(identities.reverse.size).toBe(1);
		const user = results[0]!.user;
		expect(user.passwordHash).toBeNull();
		expect(user.email).toBeNull();
		expect(await context.services.users.findSettings(user.id)).not.toBeNull();
		expect(await context.services.users.findUsersByUsername(user.username)).toHaveLength(1);
		const binding = identities.bindings.get('123456789012345678')!;
		expect(published).toHaveBeenLastCalledWith(
			'events.identity.v1.binding_changed',
			expect.objectContaining({
				user_id: user.id.toString(),
				affected_user_ids: [user.id.toString()],
			}),
			{eventId: `${binding.operation_id}:binding:${user.id}:1`},
		);
	});

	it('recovers both a half claim and account creation interrupted before commit without overwriting profiles', async () => {
		const context = createApiContext();
		const identities = new MemoryIdentities();
		const accounts = new DiscordAccountService(context, identities);
		identities.failReverseOnce = true;
		await expect(accounts.ensureDiscordAccount('123456789012345678', profile, operation)).rejects.toThrow('crash');
		const claimedId = identities.bindings.get('123456789012345678')!.user_id;
		identities.failCompleteOnce = true;
		await expect(accounts.ensureDiscordAccount('123456789012345678', profile, operation)).rejects.toThrow('crash');
		const created = await context.services.users.findUnique(claimedId);
		await context.services.users.patchUpsert(claimedId, {global_name: 'Native name'}, created!.toRow());
		const recovered = await accounts.ensureDiscordAccount(
			'123456789012345678',
			{...profile, display_name: 'Overwriting name'},
			operation,
		);
		expect(recovered.user.id).toBe(claimedId);
		expect(recovered.user.globalName).toBe('Native name');
		expect(identities.bindings.get('123456789012345678')!.state).toBe('ready');
	});

	it('fails closed when a completed binding points at a missing native account', async () => {
		const context = createApiContext();
		const identities = new MemoryIdentities();
		const accounts = new DiscordAccountService(context, identities);
		const result = await accounts.ensureDiscordAccount('123456789012345678', profile, operation);
		vi.spyOn(context.services.users, 'findUnique').mockResolvedValue(null);
		await expect(accounts.ensureDiscordAccount('123456789012345678', profile, operation)).rejects.toMatchObject({
			code: 'BOUND_ACCOUNT_MISSING',
		});
		expect(identities.bindings.get('123456789012345678')!.user_id).toBe(result.user.id);
	});

	it('authoritative resolution rejects a revoked session even while the native cache remains warm', async () => {
		const account = await createTestAccount(harness);
		await createBuilder(harness, account.token).get('/users/@me').expect(200).execute();
		const context = createApiContext();
		const service = new IntegrationService(context, new IntegrationExchangeRepository(Buffer.alloc(32, 1)));
		expect((await service.resolve(account.token)).user.id.toString()).toBe(account.userId);
		await deleteOneOrMany(
			AuthSessions.deleteByPk({session_id_hash: createHash('sha256').update(account.token).digest()}),
		);
		await expect(service.resolve(account.token)).rejects.toMatchObject({code: 'INVALID_TOKEN'});
	});

	it('checks current native disabled state and rejects stale external assertions', async () => {
		const account = await createTestAccount(harness);
		const context = createApiContext();
		const service = new IntegrationService(context, new IntegrationExchangeRepository(Buffer.alloc(32, 1)));
		await context.services.users.updateFlags(
			createUserID(BigInt(account.userId)),
			(flags) => flags | UserFlags.DISABLED,
		);
		await expect(service.resolve(account.token)).rejects.toMatchObject({code: 'ACCOUNT_UNAVAILABLE'});
		expect(() => service.verifyFresh(new Date(Date.now() - 121_000).toISOString())).toThrow();
		expect(() => service.verifyFresh(new Date(Date.now() + 31_000).toISOString())).toThrow();
	});

	it('native repository revocation publishes only after successful persistence', async () => {
		const account = await createTestAccount(harness);
		const context = createApiContext();
		const publish = vi.spyOn(IntegrationEvents, 'publishIntegrationEvent').mockResolvedValue();
		const hash = createHash('sha256').update(account.token).digest();
		vi.spyOn(BatchBuilder.prototype, 'execute').mockRejectedValueOnce(new Error('storage failure'));
		await expect(
			context.services.users.deleteAuthSessions(createUserID(BigInt(account.userId)), [hash]),
		).rejects.toThrow('storage failure');
		// 存储失败只允许保存延迟撤销意图，发送端仍需核对权威会话已不存在。
		expect(publish.mock.calls.length).toBeGreaterThan(0);
		expect(publish.mock.calls.every((call) => call[2]?.defer === true)).toBe(true);
		await context.services.users.deleteAuthSessions(createUserID(BigInt(account.userId)), [hash]);
		expect(publish).toHaveBeenCalledWith('events.auth.v1.session_invalidated', {
			user_id: account.userId,
			session_id_hash: hash.toString('base64url'),
		});
		const service = new IntegrationService(context, new IntegrationExchangeRepository(Buffer.alloc(32, 1)));
		await expect(service.resolve(account.token)).rejects.toMatchObject({code: 'INVALID_TOKEN'});
	});

	it.each([
		{label: 'recent SSO', method: 'sso', age: 1_000, valid: true},
		{label: 'exact native maximum', method: 'sso', age: 30 * 86_400_000, valid: true},
		{label: 'one millisecond expired', method: 'sso', age: 30 * 86_400_000 + 1, valid: false},
		{label: 'allowed external clock tolerance', method: 'sso', age: -30_000, valid: true},
		{label: 'beyond external clock tolerance', method: 'sso', age: -30_001, valid: false},
		{label: 'invalid timestamp', method: 'sso', age: Number.NaN, valid: false},
		{label: 'missing timestamp', method: 'sso', age: null, valid: false},
		{label: 'non-SSO native lifetime unchanged', method: null, age: 31 * 86_400_000, valid: true},
	])('preserves authoritative native session lifetime: $label', async ({method, age, valid}) => {
		const account = await createTestAccount(harness);
		const context = createApiContext();
		const hash = createHash('sha256').update(account.token).digest();
		const original = (await new AuthSessionRepository().getAuthoritativeAuthSession(hash))!;
		const now = Date.now();
		const row = {
			...original.toRow(),
			auth_method: method,
			created_at: age === null ? (undefined as unknown as Date) : new Date(now - age),
			approx_last_used_at: new Date(now),
		};
		vi.spyOn(AuthSessionRepository.prototype, 'getAuthoritativeAuthSession').mockResolvedValue(
			new AuthSessionModel(row),
		);
		const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
		try {
			const service = new IntegrationService(context, new IntegrationExchangeRepository(Buffer.alloc(32, 1)));
			if (valid) expect((await service.resolve(account.token)).user.id.toString()).toBe(account.userId);
			else await expect(service.resolve(account.token)).rejects.toMatchObject({code: 'INVALID_TOKEN'});
		} finally {
			clock.mockRestore();
		}
	});

	it('拒绝通过解析或密码证明使用过期 SSO，但仍允许显式撤销该权威行', async () => {
		const account = await createTestAccount(harness);
		const context = createApiContext();
		const hash = createHash('sha256').update(account.token).digest();
		const original = (await new AuthSessionRepository().getAuthoritativeAuthSession(hash))!;
		const expired = new AuthSessionModel({
			...original.toRow(),
			auth_method: 'sso',
			created_at: new Date(Date.now() - 31 * 86_400_000),
		});
		const authority = vi
			.spyOn(AuthSessionRepository.prototype, 'getAuthoritativeAuthSession')
			.mockResolvedValue(expired);
		const service = new IntegrationService(context, new IntegrationExchangeRepository(Buffer.alloc(32, 1)));
		const envelope = {version: 1, request_id: 'expired_session_request', token: account.token};
		await expect(service.dispatch('rpc.auth.v1.session.resolve', envelope)).rejects.toMatchObject({
			code: 'INVALID_TOKEN',
		});
		await expect(
			service.dispatch('rpc.auth.v1.external.prove', {
				...envelope,
				discord_user_id: '123456789012345678',
				verified_at: new Date().toISOString(),
				purpose: 'set_initial_password',
				operation_id: 'expired_session_prove',
			}),
		).rejects.toMatchObject({code: 'INVALID_TOKEN'});
		await expect(service.dispatch('rpc.auth.v1.session.revoke_current', envelope)).resolves.toEqual({revoked: true});
		authority.mockRestore();
		expect(await new AuthSessionRepository().getAuthoritativeAuthSession(hash)).toBeNull();
	});

	it('returns an already persisted exchange result within ten minutes without requiring a new Discord verification', async () => {
		const account = await createTestAccount(harness);
		const context = createApiContext();
		const exchanges = new IntegrationExchangeRepository(Buffer.alloc(32, 1));
		const request = IntegrationSchemas['rpc.auth.v1.external.exchange'].parse({
			version: 1,
			request_id: operation,
			exchange_id: operation,
			discord_user_id: '123456789012345678',
			verified_at: new Date(Date.now() - 180_000).toISOString(),
			profile,
			origin: {ip: '127.0.0.1', user_agent: null, client_os: null},
		});
		const record: ExchangeRecord = {
			fingerprint: createHash('sha256')
				.update(JSON.stringify({...request, request_id: undefined}))
				.digest('hex'),
			user_id: createUserID(BigInt(account.userId)),
			encrypted_token: 'encrypted',
			state: 'complete',
			expires_at: new Date(Date.now() + 300_000),
		};
		vi.spyOn(exchanges, 'find').mockResolvedValue(record);
		vi.spyOn(exchanges, 'decrypt').mockReturnValue(account.token);
		vi.spyOn(exchanges, 'complete').mockResolvedValue();
		const create = vi.spyOn(AuthSession, 'createAuthSession');
		const service = new IntegrationService(context, exchanges);
		await expect(service.dispatch('rpc.auth.v1.external.exchange', request)).resolves.toEqual({
			token: account.token,
			user_id: account.userId,
		});
		await expect(
			service.dispatch('rpc.auth.v1.external.exchange', {...request, discord_user_id: '987654321098765432'}),
		).rejects.toMatchObject({code: 'EXCHANGE_CONFLICT'});
		expect(create).not.toHaveBeenCalled();
	});

	it('never creates a second native session after an uncertain creation failure', async () => {
		const account = await createTestAccount(harness);
		const context = createApiContext();
		const exchanges = new IntegrationExchangeRepository(Buffer.alloc(32, 1));
		const request = IntegrationSchemas['rpc.auth.v1.external.exchange'].parse({
			version: 1,
			request_id: operation,
			exchange_id: operation,
			discord_user_id: '123456789012345678',
			verified_at: new Date().toISOString(),
			profile,
			origin: {ip: '127.0.0.1', user_agent: null, client_os: null},
		});
		const record: ExchangeRecord = {
			fingerprint: createHash('sha256')
				.update(JSON.stringify({...request, request_id: undefined}))
				.digest('hex'),
			user_id: createUserID(BigInt(account.userId)),
			encrypted_token: 'encrypted',
			state: 'allocated',
			expires_at: new Date(Date.now() + 600_000),
		};
		vi.spyOn(exchanges, 'find').mockResolvedValue(record);
		vi.spyOn(exchanges, 'begin').mockImplementation(async () => {
			record.state = 'executing';
			return true;
		});
		vi.spyOn(exchanges, 'decrypt').mockReturnValue(`flx_${'z'.repeat(36)}`);
		const create = vi
			.spyOn(AuthSession, 'createAuthSession')
			.mockRejectedValueOnce(new Error('uncertain storage failure'));
		const service = new IntegrationService(context, exchanges);
		await expect(service.dispatch('rpc.auth.v1.external.exchange', request)).rejects.toThrow(
			'uncertain storage failure',
		);
		await expect(service.dispatch('rpc.auth.v1.external.exchange', request)).rejects.toMatchObject({
			code: 'EXCHANGE_UNCERTAIN',
			retryable: true,
		});
		expect(create).toHaveBeenCalledOnce();
		expect(create.mock.calls[0]![1]).toMatchObject({
			authMethod: 'sso',
			signedInAt: new Date(request.verified_at),
		});
	});

	it('bounds batches and refuses arbitrary user IDs, profile keys and avatar hosts at login', () => {
		const exchange = {
			version: 1,
			request_id: operation,
			exchange_id: operation,
			discord_user_id: '123456789012345678',
			verified_at: new Date().toISOString(),
			profile,
			origin: {ip: '127.0.0.1', user_agent: null, client_os: null},
		};
		expect(IntegrationSchemas['rpc.auth.v1.external.exchange'].safeParse(exchange).success).toBe(true);
		expect(IntegrationSchemas['rpc.auth.v1.external.exchange'].safeParse({...exchange, user_id: '1234'}).success).toBe(
			false,
		);
		expect(
			IntegrationSchemas['rpc.auth.v1.external.exchange'].safeParse({
				...exchange,
				profile: {...profile, avatar_url: 'https://example.com/avatars/1'},
			}).success,
		).toBe(false);
		expect(
			IntegrationSchemas['rpc.identity.v1.profiles'].safeParse({
				version: 1,
				request_id: operation,
				user_ids: Array(101).fill('1234'),
			}).success,
		).toBe(false);
	});

	it('rejects an old Discord identity even when an exchange was prepared before administrative rebind', async () => {
		const account = await createTestAccount(harness);
		const context = createApiContext();
		const exchanges = new IntegrationExchangeRepository(Buffer.alloc(32, 1));
		const request = IntegrationSchemas['rpc.auth.v1.external.exchange'].parse({
			version: 1,
			request_id: operation,
			exchange_id: operation,
			discord_user_id: '987654321098765432',
			verified_at: new Date().toISOString(),
			profile,
			origin: {ip: '127.0.0.1', user_agent: null, client_os: null},
		});
		vi.spyOn(exchanges, 'find').mockResolvedValue({
			fingerprint: createHash('sha256')
				.update(JSON.stringify({...request, request_id: undefined}))
				.digest('hex'),
			user_id: createUserID(BigInt(account.userId)),
			encrypted_token: 'prepared',
			state: 'allocated',
			expires_at: new Date(Date.now() + 600_000),
		});
		const create = vi.spyOn(AuthSession, 'createAuthSession');
		const service = new IntegrationService(context, exchanges);
		await expect(service.dispatch('rpc.auth.v1.external.exchange', request)).rejects.toMatchObject({
			code: 'IDENTITY_NOT_CURRENT',
		});
		expect(create).not.toHaveBeenCalled();
	});
});
