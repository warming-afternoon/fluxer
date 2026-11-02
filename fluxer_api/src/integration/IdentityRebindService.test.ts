// SPDX-License-Identifier: AGPL-3.0-or-later

import {createAuthHarness, createTestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID, type UserID} from '@app/api/BrandedTypes';
import {createApiContext} from '@app/api/CreateApiContext';
import type {ApiTestHarness} from '@app/api/test/ApiTestHarness';
import {DiscordAccountService} from '@app/integration/DiscordAccountService';
import {IdentityRebindService} from '@app/integration/IdentityRebindService';
import * as IntegrationEvents from '@app/integration/IntegrationEvents';
import {IntegrationIdentityRepository} from '@app/integration/IntegrationIdentityRepository';
import {
	type IntegrationOperation,
	IntegrationOperationRepository,
} from '@app/integration/IntegrationOperationRepository';
import {UserFlags} from '@fluxer/constants/src/UserConstants';
import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@app/api/infrastructure/APIReadiness', () => ({
	startAPIReadiness: vi.fn(),
	stopAPIReadiness: vi.fn(),
	apiReady: () => true,
}));

class MemoryOperations extends IntegrationOperationRepository {
	records = new Map<string, IntegrationOperation>();
	/** 模拟永久操作占用 */
	override async find(id: string) {
		return this.records.get(id) ?? null;
	}
	/** 首次请求保留不可变的授权计划 */
	override async allocate(record: IntegrationOperation) {
		this.records.set(record.operation_id, {...record});
		return record;
	}
	/** 模拟永久结果 */
	override async complete(id: string, result: unknown) {
		this.records.get(id)!.result = JSON.stringify(result);
	}
}

class MemoryBindings extends IntegrationIdentityRepository {
	current = new Map<UserID, string>();
	canonical = new Map<UserID, UserID>();
	locks = new Map<UserID, string>();
	versions = new Map<UserID, number>();
	failSetOnce = false;
	/** 模拟稳定的历史归属 */
	override async canonicalUserId(id: UserID) {
		return this.canonical.get(id) ?? id;
	}
	/** 模拟唯一当前身份 */
	override async findDiscordId(id: UserID) {
		return this.current.get(id) ?? null;
	}
	/** 来源账户版本可高于当前节点墙钟 */
	override async bindingVersion(id: UserID) {
		return this.versions.get(id) ?? 1;
	}
	/** 恢复期间读取已占用账户的真实当前主体 */
	override async currentDuringRebind(id: UserID) {
		return this.current.get(id) ?? null;
	}
	/** 其他操作不能覆盖未完成绑定 */
	override async lockRebind(id: UserID, operation: string) {
		if (this.locks.has(id) && this.locks.get(id) !== operation) throw new Error('busy');
		this.locks.set(id, operation);
	}
	/** 原占用者释放门禁 */
	override async unlockRebind(id: UserID, operation: string) {
		if (this.locks.get(id) === operation) this.locks.delete(id);
	}
	/** 不修改历史用户行，只更新规范投影 */
	override async mergeUser(source: UserID, target: UserID) {
		this.canonical.set(source, target);
	}
	/** 在来源停用之后注入崩溃 */
	override async setCurrent(id: UserID, discord: string, _operation: string, version: number) {
		if (this.failSetOnce) {
			this.failSetOnce = false;
			throw new Error('interrupted');
		}
		this.current.set(id, discord);
		const next = Math.max(version, (this.versions.get(id) ?? 1) + 1);
		this.versions.set(id, next);
		return next;
	}
}

describe('administrative identity rebind', () => {
	let harness: ApiTestHarness;
	beforeAll(async () => {
		harness = await createAuthHarness();
	});
	beforeEach(async () => {
		await harness.reset();
		vi.restoreAllMocks();
	});
	afterAll(async () => {
		await harness?.shutdown();
	});

	it('merges an active C with its own password, preserves B password and revokes both sessions; same request recovers after interruption', async () => {
		const published = vi.spyOn(IntegrationEvents, 'publishIntegrationEvent').mockResolvedValue();
		const [admin, b, c] = await Promise.all([
			createTestAccount(harness),
			createTestAccount(harness),
			createTestAccount(harness),
		]);
		const context = createApiContext();
		const bId = createUserID(BigInt(b.userId));
		const cId = createUserID(BigInt(c.userId));
		const beforeB = (await context.services.users.findUnique(bId))!;
		const source = (await context.services.users.findUnique(cId))!;
		const beforeC = await context.services.users.patchUpsert(
			cId,
			{traits: new Set([...source.traits, 'discord_integration'])},
			source.toRow(),
		);
		const identities = new MemoryBindings();
		identities.current.set(bId, '111111111111111111');
		identities.current.set(cId, '222222222222222222');
		const sourceVersion = Date.now() + 86400000;
		identities.versions.set(cId, sourceVersion);
		identities.failSetOnce = true;
		const operations = new MemoryOperations();
		const accounts = new DiscordAccountService(context);
		vi.spyOn(accounts, 'ensureDiscordAccount').mockResolvedValue({user: beforeC, created: false, binding: {} as never});
		const service = new IdentityRebindService(context, identities, operations, accounts);
		const request = {
			version: 1 as const,
			request_id: 'request_administrative',
			operation_id: 'operation_administrative',
			actor_user_id: admin.userId,
			user_id: b.userId,
			discord_user_id: '222222222222222222',
			reason: 'Management approved migration',
			profile: {username: 'new_identity', display_name: null, avatar_url: null},
		};
		await expect(service.rebind(request)).rejects.toThrow('interrupted');
		expect((await context.services.users.findUnique(cId))!.flags & UserFlags.DISABLED).not.toBe(0n);
		expect(await context.services.users.listAuthSessions(cId)).toHaveLength(0);
		expect(identities.locks.get(bId)).toBe(request.operation_id);
		const result = await service.rebind({...request, request_id: 'request_recovery_1234'});
		expect(result).toMatchObject({
			user_id: b.userId,
			merged_user_id: c.userId,
			discord_user_id: request.discord_user_id,
		});
		expect(result.version).toBe(sourceVersion + 1);
		expect(await context.services.users.listAuthSessions(bId)).toHaveLength(0);
		expect((await context.services.users.findUnique(bId))!.passwordHash).toBe(beforeB.passwordHash);
		expect((await context.services.users.findUnique(cId))!.passwordHash).toBe(beforeC.passwordHash);
		expect(identities.current.get(bId)).toBe(request.discord_user_id);
		expect(await identities.canonicalUserId(cId)).toBe(bId);
		expect(identities.locks.size).toBe(0);
		await expect(service.rebind(request)).resolves.toEqual(result);
		expect(published).toHaveBeenCalledWith(
			'events.identity.v1.binding_changed',
			expect.objectContaining({
				kind: 'managed_merge',
				operation_id: request.operation_id,
				actor_user_id: admin.userId,
				discord_user_id: request.discord_user_id,
				user_id: b.userId,
				merged_user_id: c.userId,
			}),
			{eventId: `${request.operation_id}:binding`},
		);
		for (const id of [b.userId, c.userId])
			expect(published).toHaveBeenCalledWith(
				'events.auth.v1.user_invalidated',
				{user_id: id},
				{eventId: `${request.operation_id}:user:${id}`},
			);
		await expect(service.rebind({...request, user_id: c.userId})).rejects.toMatchObject({code: 'OPERATION_CONFLICT'});
	});
});
