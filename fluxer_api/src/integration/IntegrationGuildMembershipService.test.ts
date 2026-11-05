// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ApiContext} from '@app/api/ApiContext';
import {createUserID} from '@app/api/BrandedTypes';
import {
	REGISTRATION_PENDING_APPROVAL_TRAIT,
	REGISTRATION_REJECTED_TRAIT,
} from '@app/api/instance/InstanceConfigRepository';
import {DiscordAccountService} from '@app/integration/DiscordAccountService';
import * as IntegrationEvents from '@app/integration/IntegrationEvents';
import {IntegrationGuildMembershipService} from '@app/integration/IntegrationGuildMembershipService';
import {type DiscordBinding, IntegrationIdentityRepository} from '@app/integration/IntegrationIdentityRepository';
import {
	type IntegrationOperation,
	IntegrationOperationRepository,
} from '@app/integration/IntegrationOperationRepository';
import type {NativeAccountRepository} from '@app/integration/NativeAccountRepository';
import {UserFlags} from '@fluxer/constants/src/UserConstants';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => ({join: vi.fn(), publish: vi.fn()}));
const guildId = '123456789012345678';
const userId = createUserID(234567890123456789n);
const profile = {username: 'forumuser', display_name: null, avatar_url: null};
function binding(overrides: Partial<DiscordBinding> = {}): DiscordBinding {
	return {
		discord_user_id: '345678901234567890',
		user_id: userId,
		operation_id: 'forum_creation_123456',
		username: 'forumuser',
		display_name: null,
		avatar_url: null,
		state: 'pending',
		version: 1,
		created_at: new Date(),
		creation_source: 'forum',
		creation_guild_id: guildId,
		...overrides,
	};
}
class MemoryOperations extends IntegrationOperationRepository {
	records = new Map<string, IntegrationOperation>();
	override async find(id: string) {
		return this.records.get(id) ?? null;
	}
	override async allocate(record: IntegrationOperation) {
		if (!this.records.has(record.operation_id)) this.records.set(record.operation_id, {...record});
		return this.records.get(record.operation_id)!;
	}
	override async completeOnce(id: string, result: unknown) {
		const record = this.records.get(id)!;
		record.result ??= JSON.stringify(result);
		return JSON.parse(record.result);
	}
}
function harness() {
	const user = {
		id: userId,
		flags: 0n,
		isBot: false,
		isSystem: false,
		pendingDeletionAt: null as Date | null,
		deletionStartedAt: null as Date | null,
		traits: new Set<string>(),
	};
	const cache = {
		acquireLock: vi.fn().mockResolvedValue('lease'),
		extendLock: vi.fn().mockResolvedValue(true),
		releaseLock: vi.fn().mockResolvedValue(undefined),
	};
	const context = {
		services: {
			cache,
			users: {findUnique: vi.fn().mockResolvedValue(user)},
			snowflake: {generate: vi.fn().mockResolvedValue(userId)},
		},
	} as unknown as ApiContext;
	const guilds = {
		findUnique: vi.fn().mockResolvedValue({id: BigInt(guildId)}),
		listBans: vi.fn().mockResolvedValue([]),
		getMember: vi.fn().mockResolvedValue(null),
		getMembershipMetadata: vi.fn().mockResolvedValue(null),
	};
	const instance = {
		getInstancePolicyConfig: vi
			.fn()
			.mockResolvedValue({single_community_enabled: false, single_community_guild_id: null}),
	};
	const operations = new MemoryOperations();
	const service = new IntegrationGuildMembershipService(
		context,
		operations,
		guilds as never,
		instance as never,
		mocks.join,
	);
	return {user, cache, context, guilds, instance, operations, service};
}
beforeEach(() => {
	vi.clearAllMocks();
	mocks.join.mockReset().mockResolvedValue(undefined);
	mocks.publish.mockResolvedValue(undefined);
	vi.spyOn(IntegrationEvents, 'publishIntegrationEvent').mockImplementation(mocks.publish);
	vi.stubEnv('INTEGRATION_GUILD_ID', guildId);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe('Forum creation guild enrollment', () => {
	it.each([undefined, '', '0', '-1', ' 123', '9223372036854775808', 'not-a-guild'])(
		'rejects missing or invalid explicit configuration: %s',
		async (target) => {
			vi.stubEnv('INTEGRATION_GUILD_ID', target);
			const h = harness();
			h.instance.getInstancePolicyConfig.mockResolvedValue({
				single_community_enabled: true,
				single_community_guild_id: guildId,
			});
			await expect(h.service.configuredTarget()).rejects.toMatchObject({code: 'FORUM_GUILD_NOT_CONFIGURED'});
			expect(h.guilds.findUnique).not.toHaveBeenCalled();
		},
	);
	it('rejects a sole-community mismatch rather than choosing its guild', async () => {
		const h = harness();
		h.instance.getInstancePolicyConfig.mockResolvedValue({
			single_community_enabled: true,
			single_community_guild_id: '999',
		});
		await expect(h.service.configuredTarget()).rejects.toMatchObject({code: 'FORUM_GUILD_CONFIGURATION_CONFLICT'});
	});
	it('rejects a nonexistent configured guild', async () => {
		const h = harness();
		h.guilds.findUnique.mockResolvedValue(null);
		await expect(h.service.configuredTarget()).rejects.toMatchObject({code: 'FORUM_GUILD_NOT_CONFIGURED'});
	});
	it.each(['other', null, undefined] as const)('does not infer Forum provenance for %s', async (source) => {
		const h = harness();
		await expect(h.service.ensureForCreation(binding({creation_source: source}))).rejects.toMatchObject({
			code: 'RESOURCE_NOT_ALLOWED',
		});
		expect(h.cache.acquireLock).not.toHaveBeenCalled();
	});
	it('does not infer a missing stored creation guild from current configuration', async () => {
		await expect(harness().service.ensureForCreation(binding({creation_guild_id: null}))).rejects.toMatchObject({
			code: 'RESOURCE_NOT_ALLOWED',
		});
	});
	it.each(['disabled', 'deleted', 'self-deleted', 'pending', 'rejected', 'deleting', 'missing'])(
		'rejects %s accounts before joining or allocating a plan',
		async (state) => {
			const h = harness();
			if (state === 'disabled') h.user.flags = UserFlags.DISABLED;
			if (state === 'deleted') h.user.flags = UserFlags.DELETED;
			if (state === 'self-deleted') h.user.flags = UserFlags.SELF_DELETED;
			if (state === 'pending') h.user.traits.add(REGISTRATION_PENDING_APPROVAL_TRAIT);
			if (state === 'rejected') h.user.traits.add(REGISTRATION_REJECTED_TRAIT);
			if (state === 'deleting') h.user.deletionStartedAt = new Date();
			if (state === 'missing') vi.mocked(h.context.services.users.findUnique).mockResolvedValue(null);
			await expect(h.service.ensureForCreation(binding())).rejects.toMatchObject({code: 'ACCOUNT_UNAVAILABLE'});
			expect(mocks.join).not.toHaveBeenCalled();
			expect(h.operations.records.size).toBe(0);
			expect(h.cache.releaseLock).toHaveBeenCalled();
		},
	);
	it('fails closed when the operation lock cannot be acquired', async () => {
		const h = harness();
		h.cache.acquireLock.mockResolvedValue(null);
		await expect(h.service.ensureForCreation(binding())).rejects.toMatchObject({code: 'BUSY', retryable: true});
		expect(mocks.join).not.toHaveBeenCalled();
		expect(h.operations.records.size).toBe(0);
	});
	it('does not join after losing its lease', async () => {
		const h = harness();
		h.cache.extendLock.mockResolvedValue(false);
		await expect(h.service.ensureForCreation(binding())).rejects.toMatchObject({code: 'BUSY'});
		expect(mocks.join).not.toHaveBeenCalled();
		expect([...h.operations.records.values()][0].result).toBeNull();
	});
	it('retains the exact immutable plan after a join failure and completes on retry', async () => {
		const h = harness();
		const left = new Date('2025-01-02T03:04:05Z');
		h.guilds.getMembershipMetadata.mockResolvedValue({last_left_at: left});
		mocks.join.mockRejectedValueOnce(new Error('interrupted'));
		await expect(h.service.ensureForCreation(binding())).rejects.toThrow('interrupted');
		const payload = [...h.operations.records.values()][0].payload;
		h.guilds.getMembershipMetadata.mockResolvedValue({last_left_at: new Date()});
		await h.service.ensureForCreation(binding());
		expect(h.operations.records.size).toBe(1);
		expect([...h.operations.records.values()][0].payload).toBe(payload);
		expect(mocks.join.mock.calls[1][0].recovery).toEqual(mocks.join.mock.calls[0][0].recovery);
		expect(mocks.join.mock.calls[1][0].recovery.lastLeftAt).toBe(left.toISOString());
		expect(h.guilds.getMembershipMetadata).toHaveBeenCalledTimes(1);
	});
	it('does not persist completion if the lease is lost after joining', async () => {
		const h = harness();
		h.cache.extendLock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
		await expect(h.service.ensureForCreation(binding())).rejects.toMatchObject({code: 'BUSY'});
		expect([...h.operations.records.values()][0].result).toBeNull();
		await h.service.ensureForCreation(binding());
		expect(mocks.join.mock.calls[1][0].recovery).toEqual(mocks.join.mock.calls[0][0].recovery);
	});
	it('durable completion prevents rejoining after a voluntary leave, even in a fresh service', async () => {
		const h = harness();
		await h.service.ensureForCreation(binding());
		h.guilds.getMember.mockResolvedValue(null);
		const restarted = new IntegrationGuildMembershipService(
			h.context,
			h.operations,
			h.guilds as never,
			h.instance as never,
			mocks.join,
		);
		await restarted.ensureForCreation(binding());
		expect(mocks.join).toHaveBeenCalledTimes(1);
	});
	it('rejects a banned account without joining or marking completion', async () => {
		const h = harness();
		h.guilds.listBans.mockResolvedValue([{userId}]);
		await expect(h.service.ensureForCreation(binding())).rejects.toThrow();
		expect(mocks.join).not.toHaveBeenCalled();
		expect(h.operations.records.size).toBe(0);
	});
	it('refuses to redirect an immutable creation target when configuration changes', async () => {
		const h = harness();
		vi.stubEnv('INTEGRATION_GUILD_ID', '999');
		await expect(h.service.ensureForCreation(binding())).rejects.toMatchObject({
			code: 'FORUM_GUILD_CONFIGURATION_CONFLICT',
		});
		expect(mocks.join).not.toHaveBeenCalled();
		expect(h.operations.records.size).toBe(0);
	});
	it('records an existing membership without adding it again', async () => {
		const h = harness();
		h.guilds.getMember.mockResolvedValue({userId});
		await h.service.ensureForCreation(binding());
		expect(mocks.join).not.toHaveBeenCalled();
		expect([...h.operations.records.values()][0].result).not.toBeNull();
	});
});

function accountHarness(existing: DiscordBinding | null = null) {
	const h = harness();
	let stored = existing;
	const identities = new IntegrationIdentityRepository();
	vi.spyOn(identities, 'find').mockImplementation(async () => stored);
	vi.spyOn(identities, 'claim').mockImplementation(async (id, uid, operation, p, username, provenance) => {
		stored = binding({
			discord_user_id: id,
			user_id: uid,
			operation_id: operation,
			username,
			display_name: p.display_name,
			creation_source: provenance?.source,
			creation_guild_id: provenance?.guildId,
		});
		return stored;
	});
	vi.spyOn(identities, 'ensureReverse').mockResolvedValue();
	vi.spyOn(identities, 'complete').mockImplementation(async () => {
		stored!.state = 'ready';
	});
	vi.spyOn(identities, 'canonicalUserId').mockImplementation(async (id) => id);
	vi.spyOn(identities, 'findDiscordId').mockResolvedValue(binding().discord_user_id);
	vi.spyOn(identities, 'bindingVersion').mockResolvedValue(1);
	const native = {initialize: vi.fn().mockResolvedValue(h.user)};
	const membership = {
		configuredTarget: vi.fn().mockResolvedValue(guildId),
		ensureForCreation: vi.fn().mockResolvedValue(undefined),
	};
	const accounts = new DiscordAccountService(
		h.context,
		identities,
		native as unknown as NativeAccountRepository,
		membership as unknown as IntegrationGuildMembershipService,
	);
	return {...h, identities, native, membership, accounts};
}
describe('Discord account creation provenance boundary', () => {
	it('persists Forum provenance and enrolls before marking the binding ready', async () => {
		const h = accountHarness();
		h.membership.ensureForCreation.mockImplementation(async () => {
			expect(h.identities.complete).not.toHaveBeenCalled();
		});
		await h.accounts.ensureDiscordAccount(binding().discord_user_id, profile, binding().operation_id, 'forum');
		expect(h.identities.claim).toHaveBeenCalledWith(
			expect.anything(),
			userId,
			expect.anything(),
			profile,
			'forumuser',
			{source: 'forum', guildId},
		);
		expect(h.membership.ensureForCreation).toHaveBeenCalledTimes(1);
		expect(h.identities.complete).toHaveBeenCalledTimes(1);
	});
	it('defaults Bot provisioning to other and never looks up a guild', async () => {
		const h = accountHarness();
		await h.accounts.ensureDiscordAccount(binding().discord_user_id, profile, binding().operation_id);
		expect(h.identities.claim).toHaveBeenCalledWith(
			expect.anything(),
			userId,
			expect.anything(),
			profile,
			'forumuser',
			{source: 'other', guildId: null},
		);
		expect(h.membership.configuredTarget).not.toHaveBeenCalled();
		expect(h.membership.ensureForCreation).not.toHaveBeenCalled();
	});
	it.each(['forum', 'other', undefined] as const)(
		'ready %s bindings never re-enroll on Forum login',
		async (source) => {
			const h = accountHarness(binding({state: 'ready', creation_source: source}));
			await h.accounts.ensureDiscordAccount(binding().discord_user_id, profile, 'new_login_operation', 'forum');
			expect(h.membership.ensureForCreation).not.toHaveBeenCalled();
			expect(h.membership.configuredTarget).not.toHaveBeenCalled();
			expect(h.native.initialize).not.toHaveBeenCalled();
		},
	);
	it('does not promote an existing pending Bot account to Forum enrollment', async () => {
		const h = accountHarness(binding({creation_source: 'other', creation_guild_id: null}));
		await h.accounts.ensureDiscordAccount(binding().discord_user_id, profile, 'new_login_operation', 'forum');
		expect(h.membership.ensureForCreation).not.toHaveBeenCalled();
		expect(h.identities.claim).not.toHaveBeenCalled();
	});
	it('requires Forum to resume a pending Forum creation', async () => {
		const h = accountHarness(binding());
		await expect(
			h.accounts.ensureDiscordAccount(binding().discord_user_id, profile, 'bot_retry_operation'),
		).rejects.toMatchObject({code: 'IDENTITY_BUSY'});
		expect(h.native.initialize).not.toHaveBeenCalled();
		expect(h.identities.complete).not.toHaveBeenCalled();
	});
	it('leaves a failed enrollment pending so a Forum retry can resume it', async () => {
		const h = accountHarness();
		h.membership.ensureForCreation.mockRejectedValueOnce(new Error('join failed'));
		await expect(
			h.accounts.ensureDiscordAccount(binding().discord_user_id, profile, binding().operation_id, 'forum'),
		).rejects.toThrow('join failed');
		expect(h.identities.complete).not.toHaveBeenCalled();
		await h.accounts.ensureDiscordAccount(binding().discord_user_id, profile, 'retry_creation_12345', 'forum');
		expect(h.identities.claim).toHaveBeenCalledTimes(1);
		expect(h.membership.ensureForCreation).toHaveBeenCalledTimes(2);
		expect(h.identities.complete).toHaveBeenCalledTimes(1);
	});
});
