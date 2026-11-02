// SPDX-License-Identifier: AGPL-3.0-or-later

import {createAuthHarness, createTestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createChannelID} from '@app/api/BrandedTypes';
import {createApiContext} from '@app/api/CreateApiContext';
import {ChannelRepository} from '@app/api/channel/ChannelRepository';
import {ThreadPolicyRepository} from '@app/api/channel/services/thread/ThreadPolicyRepository';
import {createGuild, setupTestGuildWithMembers} from '@app/api/channel/tests/ChannelTestUtils';
import {threadsRequest} from '@app/api/channel/tests/ThreadTestUtils';
import {clearChannelThreadsTaintCacheForTesting} from '@app/api/experiment/ChannelThreadsGate';
import {ensureSessionStarted} from '@app/api/message/tests/MessageTestUtils';
import type {ApiTestHarness} from '@app/api/test/ApiTestHarness';
import {IntegrationContentService} from '@app/integration/IntegrationContentService';
import {IntegrationError} from '@app/integration/IntegrationError';
import {IntegrationIdentityRepository} from '@app/integration/IntegrationIdentityRepository';
import {
	type IntegrationOperation,
	IntegrationOperationRepository,
} from '@app/integration/IntegrationOperationRepository';
import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import {UserFlags} from '@fluxer/constants/src/UserConstants';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@app/api/infrastructure/APIReadiness', () => ({
	startAPIReadiness: vi.fn(),
	stopAPIReadiness: vi.fn(),
	apiReady: () => true,
}));

class MemoryOperations extends IntegrationOperationRepository {
	records = new Map<string, IntegrationOperation>();
	resources = new Map<string, string>();
	failCompleteOnce = false;
	/** 模拟不可变操作计划 */
	override async find(id: string) {
		return this.records.get(id) ?? null;
	}
	/** 保存恢复计划 */
	override async allocate(record: IntegrationOperation) {
		this.records.set(record.operation_id, {...record});
		return record;
	}
	/** 模拟副作用成功而结果持久化失败 */
	override async complete(id: string, result: unknown) {
		if (this.failCompleteOnce) {
			this.failCompleteOnce = false;
			throw new Error('result persistence interrupted');
		}
		this.records.get(id)!.result = JSON.stringify(result);
	}
	/** 未完成操作保留资源占用 */
	override async lockResource(resource: string, operation: string) {
		if (this.resources.has(resource) && this.resources.get(resource) !== operation)
			throw new IntegrationError('RESOURCE_BUSY', 'unfinished operation', true);
		this.resources.set(resource, operation);
	}
	/** 仅原占用者释放 */
	override async releaseResource(resource: string, operation: string) {
		if (this.resources.get(resource) === operation) this.resources.delete(resource);
	}
}

describe('restricted content RPC native business paths', () => {
	let harness: ApiTestHarness;
	beforeAll(async () => {
		harness = await createAuthHarness();
	});
	beforeEach(async () => {
		await harness.reset();
		vi.restoreAllMocks();
		clearChannelThreadsTaintCacheForTesting();
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});
	afterAll(async () => {
		await harness?.shutdown();
	});

	it('creates exactly one native thread after result persistence fails, then reads and edits the real starter', async () => {
		const owner = await createTestAccount(harness);
		await ensureSessionStarted(harness, owner.token);
		const guild = await createGuild(harness, owner.token, 'integration');
		const forums: Array<string> = [];
		for (let index = 0; index < 4; index++)
			forums.push(
				(
					await threadsRequest<{id: string}>(harness, owner.token)
						.post(`/guilds/${guild.id}/channels`)
						.body({name: `forum${index}`, type: ChannelTypes.GUILD_FORUM})
						.execute()
				).id,
			);
		vi.stubEnv('INTEGRATION_GUILD_ID', guild.id);
		vi.stubEnv('INTEGRATION_FORUM_CHANNEL_IDS', forums.join(','));
		const operations = new MemoryOperations();
		const service = new IntegrationContentService(createApiContext(), operations);
		const request = {
			version: 1,
			request_id: 'request_create_native',
			operation_id: 'operation_create_native',
			actor_user_id: owner.userId,
			guild_id: guild.id,
			channel_id: forums[0],
			name: 'native starter',
			content: 'original body',
		};
		operations.failCompleteOnce = true;
		await expect(service.dispatch('rpc.content.v1.thread.create_service', request)).rejects.toThrow(
			'result persistence interrupted',
		);
		const created = (await service.dispatch('rpc.content.v1.thread.create_service', {
			...request,
			request_id: 'request_create_retry',
		})) as {thread_id: string};
		const repository = new ChannelRepository();
		expect(await repository.threads.listParentThreads(createChannelID(BigInt(forums[0]!)))).toHaveLength(1);
		expect(
			(
				await repository.messages.getMessage(
					createChannelID(BigInt(created.thread_id)),
					BigInt(created.thread_id) as never,
				)
			)?.content,
		).toBe('original body');
		const common = {
			version: 1,
			request_id: 'request_read_native1',
			operation_id: 'operation_read_native',
			actor_user_id: owner.userId,
			guild_id: guild.id,
			thread_id: created.thread_id,
		};
		await expect(
			service.dispatch('rpc.content.v1.starter.edit_service', {
				...common,
				operation_id: 'operation_edit_native',
				content: 'edited body',
			}),
		).resolves.toMatchObject({message_id: created.thread_id});
		await expect(service.dispatch('rpc.content.v1.thread.read_service', common)).resolves.toMatchObject({
			message: {id: created.thread_id, content: 'edited body'},
		});
		await expect(
			service.dispatch('rpc.content.v1.thread.create_service', {...request, content: 'conflicting body'}),
		).rejects.toMatchObject({code: 'OPERATION_CONFLICT'});
		const uncertainEdit = {...common, operation_id: 'operation_uncertain_edit', content: 'uncertain edit body'};
		operations.failCompleteOnce = true;
		await expect(service.dispatch('rpc.content.v1.starter.edit_service', uncertainEdit)).rejects.toThrow(
			'result persistence interrupted',
		);
		await threadsRequest(harness, owner.token)
			.patch(`/channels/${created.thread_id}/messages/${created.thread_id}`)
			.body({content: 'newer native edit'})
			.execute();
		await expect(service.dispatch('rpc.content.v1.starter.edit_service', uncertainEdit)).rejects.toMatchObject({
			code: 'MESSAGE_VERSION_CONFLICT',
		});
		await expect(service.dispatch('rpc.content.v1.thread.read_service', common)).resolves.toMatchObject({
			message: {content: 'newer native edit'},
		});
		expect(operations.resources.size).toBe(0);
	});

	it('allows only delegated title and archive fields for a different native member and rejects out of scope requests', async () => {
		const {owner, members, guild} = await setupTestGuildWithMembers(harness, 1);
		await ensureSessionStarted(harness, owner.token);
		const forum = await threadsRequest<{id: string}>(harness, owner.token)
			.post(`/guilds/${guild.id}/channels`)
			.body({name: 'forum', type: ChannelTypes.GUILD_FORUM})
			.execute();
		vi.stubEnv('INTEGRATION_GUILD_ID', guild.id);
		vi.stubEnv(
			'INTEGRATION_FORUM_CHANNEL_IDS',
			[forum.id, '111111111111111111', '222222222222222222', '333333333333333333'].join(','),
		);
		const operations = new MemoryOperations();
		const service = new IntegrationContentService(createApiContext(), operations);
		const created = (await service.dispatch('rpc.content.v1.thread.create_service', {
			version: 1,
			request_id: 'request_delegated1',
			operation_id: 'operation_delegated1',
			actor_user_id: owner.userId,
			guild_id: guild.id,
			channel_id: forum.id,
			name: 'before',
			content: 'body',
		})) as {thread_id: string};
		const request = {
			version: 1,
			request_id: 'request_delegated2',
			operation_id: 'operation_delegated2',
			actor_user_id: members[0]!.userId,
			guild_id: guild.id,
			thread_id: created.thread_id,
			name: 'after',
			archived: true,
		};
		await expect(service.dispatch('rpc.content.v1.thread.update_service', request)).resolves.toMatchObject({
			thread_id: created.thread_id,
		});
		const repository = new ChannelRepository();
		expect((await repository.channelData.findUnique(createChannelID(BigInt(created.thread_id))))?.name).toBe('after');
		expect((await repository.threads.getState(createChannelID(BigInt(created.thread_id))))?.archived).toBe(true);
		await expect(
			service.dispatch('rpc.content.v1.thread.update_service', {
				...request,
				operation_id: 'operation_forbidden1',
				locked: false,
			}),
		).rejects.toThrow();
		await expect(
			service.dispatch('rpc.content.v1.thread.create_service', {
				version: 1,
				request_id: 'request_forbidden1',
				operation_id: 'operation_forbidden2',
				actor_user_id: owner.userId,
				guild_id: guild.id,
				channel_id: '444444444444444444',
				name: 'forbidden',
				content: 'body',
			}),
		).rejects.toMatchObject({code: 'RESOURCE_NOT_ALLOWED'});
	});

	it('lets B edit only merged C starter body and records B while keeping the original native author C', async () => {
		const {owner: b, members, guild} = await setupTestGuildWithMembers(harness, 1);
		const c = members[0]!;
		await ensureSessionStarted(harness, c.token);
		const forum = await threadsRequest<{id: string}>(harness, b.token)
			.post(`/guilds/${guild.id}/channels`)
			.body({name: 'forum', type: ChannelTypes.GUILD_FORUM})
			.execute();
		vi.stubEnv('INTEGRATION_GUILD_ID', guild.id);
		vi.stubEnv(
			'INTEGRATION_FORUM_CHANNEL_IDS',
			[forum.id, '111111111111111111', '222222222222222222', '333333333333333333'].join(','),
		);
		const context = createApiContext();
		const operations = new MemoryOperations();
		const service = new IntegrationContentService(context, operations);
		const created = (await service.dispatch('rpc.content.v1.thread.create_service', {
			version: 1,
			request_id: 'request_merged_post1',
			operation_id: 'operation_merged_post1',
			actor_user_id: c.userId,
			guild_id: guild.id,
			channel_id: forum.id,
			name: 'historical title',
			content: 'historical body',
		})) as {thread_id: string};
		const original = (await context.services.users.findUnique(BigInt(c.userId) as never))!;
		await context.services.users.patchUpsert(
			original.id,
			{traits: new Set([...original.traits, 'discord_integration']), flags: original.flags | UserFlags.DISABLED},
			original.toRow(),
		);
		vi.stubEnv('FLUXER_THREAD_POLICY_ENABLED', 'true');
		vi.spyOn(ThreadPolicyRepository.prototype, 'list').mockResolvedValue([]);
		vi.spyOn(IntegrationIdentityRepository.prototype, 'canonicalUserId').mockResolvedValue(BigInt(b.userId) as never);
		const audit = vi
			.spyOn(IntegrationOperationRepository.prototype, 'allocate')
			.mockImplementation(async (record) => record);
		vi.spyOn(IntegrationOperationRepository.prototype, 'complete').mockResolvedValue();
		await expect(
			service.dispatch('rpc.content.v1.starter.edit_service', {
				version: 1,
				request_id: 'request_merged_edit1',
				operation_id: 'operation_merged_edit1',
				actor_user_id: b.userId,
				guild_id: guild.id,
				thread_id: created.thread_id,
				content: 'body edited by B',
			}),
		).resolves.toMatchObject({message_id: created.thread_id});
		const message = await new ChannelRepository().messages.getMessage(
			createChannelID(BigInt(created.thread_id)),
			BigInt(created.thread_id) as never,
		);
		expect(message?.authorId?.toString()).toBe(c.userId);
		expect(message?.content).toBe('body edited by B');
		expect(audit).toHaveBeenCalledWith(
			expect.objectContaining({
				actor_id: BigInt(b.userId),
				payload: expect.stringContaining(`"original_author_id":"${c.userId}"`),
			}),
		);
		const record = audit.mock.calls[0]![0];
		expect(JSON.parse(record.payload)).toMatchObject({
			actor_user_id: b.userId,
			before_content: 'historical body',
			after_content: 'body edited by B',
		});
	});
});
