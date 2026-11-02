// SPDX-License-Identifier: AGPL-3.0-or-later

import {createAuthHarness, createTestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createChannelID, createGuildID} from '@app/api/BrandedTypes';
import {Config, getConfig} from '@app/api/Config';
import {createApiContext} from '@app/api/CreateApiContext';
import {ChannelRepository} from '@app/api/channel/ChannelRepository';
import {AttachmentUploadTraceRepository} from '@app/api/channel/repositories/message/AttachmentUploadTraceRepository';
import {AttachmentProcessingService} from '@app/api/channel/services/message/AttachmentProcessingService';
import type {ThreadPolicy} from '@app/api/channel/services/thread/ThreadPolicyRepository';
import {ThreadPolicyRepository} from '@app/api/channel/services/thread/ThreadPolicyRepository';
import {loadFixture} from '@app/api/channel/tests/AttachmentTestUtils';
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
		getConfig().presignedAttachmentUploadsEnabled = false;
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
		// 规范合并关系不是普通 HTTP 的作者权限；仅受信 Forum 主帖能力可代理编辑。
		await threadsRequest(harness, b.token)
			.patch(`/channels/${created.thread_id}/messages/${created.thread_id}`)
			.body({content: 'ordinary HTTP must not delegate'})
			.expect(403)
			.execute();
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

	it('projects independently sourced external locks into real native archive indexes and retains native admin changes on release', async () => {
		const owner = await createTestAccount(harness);
		await ensureSessionStarted(harness, owner.token);
		const guild = await createGuild(harness, owner.token, 'policies');
		const forum = await threadsRequest<{id: string}>(harness, owner.token)
			.post(`/guilds/${guild.id}/channels`)
			.body({name: 'forum', type: ChannelTypes.GUILD_FORUM})
			.execute();
		vi.stubEnv('INTEGRATION_GUILD_ID', guild.id);
		vi.stubEnv(
			'INTEGRATION_FORUM_CHANNEL_IDS',
			[forum.id, '111111111111111111', '222222222222222222', '333333333333333333'].join(','),
		);
		vi.stubEnv('FLUXER_THREAD_POLICY_ENABLED', 'true');
		const policies = new Map<string, ThreadPolicy>();
		const policyChannels = new Map<string, bigint>();
		vi.spyOn(ThreadPolicyRepository.prototype, 'set').mockImplementation(async (channel, _user, policy) => {
			policyChannels.set(policy.source, channel);
			policies.set(policy.source, policy);
		});
		vi.spyOn(ThreadPolicyRepository.prototype, 'list').mockImplementation(async (channel) =>
			[...policies.values()].filter((policy) => policyChannels.get(policy.source) === channel),
		);
		vi.spyOn(ThreadPolicyRepository.prototype, 'hasActiveLock').mockImplementation(async (channel) =>
			[...policies.values()].some(
				(policy) => policyChannels.get(policy.source) === channel && policy.kind === 'lock' && policy.active,
			),
		);
		const service = new IntegrationContentService(createApiContext(), new MemoryOperations());
		const base = {
			version: 1,
			request_id: 'request_policy_native',
			operation_id: 'operation_policy_create',
			actor_user_id: owner.userId,
			guild_id: guild.id,
		};
		const created = (await service.dispatch('rpc.content.v1.thread.create_service', {
			...base,
			channel_id: forum.id,
			name: 'policy post',
			content: 'body',
		})) as {thread_id: string};
		const repository = new ChannelRepository();
		let revision = 0;
		const change = async (source: string, active: boolean) =>
			service.dispatch('rpc.content.v1.thread.policy_service', {
				...base,
				operation_id: `operation_policy_change_${++revision}`,
				thread_id: created.thread_id,
				kind: 'lock',
				source,
				active,
				policy_version: revision,
			});
		await change('forum_work_lock', true);
		expect(await repository.threads.getState(createChannelID(BigInt(created.thread_id)))).toMatchObject({
			locked: true,
			archived: true,
		});
		expect(await repository.threads.listActiveThreads(createGuildID(BigInt(guild.id)))).toHaveLength(0);
		await threadsRequest(harness, owner.token)
			.patch(`/channels/${created.thread_id}`)
			.body({archived: false, locked: false})
			.execute();
		expect(await repository.threads.getState(createChannelID(BigInt(created.thread_id)))).toMatchObject({
			locked: true,
			archived: true,
		});
		await change('forum_soft_delete', true);
		await change('forum_work_lock', false);
		expect((await repository.threads.getState(createChannelID(BigInt(created.thread_id))))?.externalLocked).toBe(true);
		await threadsRequest(harness, owner.token)
			.patch(`/channels/${created.thread_id}`)
			.body({archived: true, locked: true})
			.execute();
		await change('forum_soft_delete', false);
		expect(await repository.threads.getState(createChannelID(BigInt(created.thread_id)))).toMatchObject({
			locked: true,
			archived: true,
			externalLocked: false,
			nativeLocked: true,
			nativeArchived: true,
		});
		await threadsRequest(harness, owner.token)
			.patch(`/channels/${created.thread_id}`)
			.body({archived: false, locked: false})
			.execute();
		expect(await repository.threads.listActiveThreads(createGuildID(BigInt(guild.id)))).toHaveLength(1);
	});

	it('persists inherited user penalties before the native channel exists and refuses a muted creator before publishing a thread', async () => {
		const {owner, members, guild} = await setupTestGuildWithMembers(harness, 1);
		const target = members[0]!;
		await ensureSessionStarted(harness, owner.token);
		await ensureSessionStarted(harness, target.token);
		const forum = await threadsRequest<{id: string}>(harness, owner.token)
			.post(`/guilds/${guild.id}/channels`)
			.body({name: 'inherited', type: ChannelTypes.GUILD_FORUM})
			.execute();
		vi.stubEnv('INTEGRATION_GUILD_ID', guild.id);
		vi.stubEnv(
			'INTEGRATION_FORUM_CHANNEL_IDS',
			[forum.id, '111111111111111111', '222222222222222222', '333333333333333333'].join(','),
		);
		vi.stubEnv('FLUXER_THREAD_POLICY_ENABLED', 'true');
		const stored: Array<{channel: bigint; user: bigint; policy: ThreadPolicy}> = [];
		vi.spyOn(ThreadPolicyRepository.prototype, 'set').mockImplementation(async (channel, user, policy) => {
			if (policy.active) expect(await new ChannelRepository().channelData.findUnique(channel)).toBeNull();
			const previous = stored.findIndex(
				(item) => item.channel === channel && item.user === user && item.policy.source === policy.source,
			);
			if (previous >= 0) stored.splice(previous, 1);
			stored.push({channel, user, policy});
		});
		vi.spyOn(ThreadPolicyRepository.prototype, 'list').mockImplementation(async (channel, user) =>
			stored
				.filter((item) => item.channel === channel && (item.user === user || item.user === 0n))
				.map((item) => item.policy),
		);
		vi.spyOn(ThreadPolicyRepository.prototype, 'hasActiveLock').mockImplementation(async (channel) =>
			stored.some((item) => item.channel === channel && item.policy.kind === 'lock' && item.policy.active),
		);
		const operations = new MemoryOperations();
		const service = new IntegrationContentService(createApiContext(), operations);
		const request = {
			version: 1,
			request_id: 'request_inherited_policy',
			operation_id: 'operation_inherited_policy',
			actor_user_id: owner.userId,
			guild_id: guild.id,
			channel_id: forum.id,
			name: 'inherited policy post',
			content: 'body',
			initial_policies: [
				{source: 'forum_work_mute', policy_version: 1, target_user_id: target.userId, active: true, expires_at: null},
			],
		};
		const created = (await service.dispatch('rpc.content.v1.thread.create_service', request)) as {thread_id: string};
		await threadsRequest(harness, target.token)
			.post(`/channels/${created.thread_id}/messages`)
			.body({content: 'blocked'})
			.expect(403)
			.execute();
		await expect(
			service.dispatch('rpc.content.v1.thread.create_service', {
				...request,
				operation_id: 'operation_muted_creator',
				initial_policies: [{...request.initial_policies[0], target_user_id: owner.userId}],
			}),
		).rejects.toMatchObject({code: 'MISSING_PERMISSIONS'});
		const failedPlan = JSON.parse(operations.records.get('operation_muted_creator')!.payload).operation_plan;
		expect(
			await new ChannelRepository().channelData.findUnique(createChannelID(BigInt(failedPlan.thread_id))),
		).toBeNull();
		expect(operations.resources.size).toBe(0);
	});

	it('keeps a nonmoderator child closed through initialization, permits only its internal starter, and never reopens or relocks on RPC replay', async () => {
		const {owner, members, guild} = await setupTestGuildWithMembers(harness, 1);
		const creator = members[0]!;
		await ensureSessionStarted(harness, creator.token);
		const forum = await threadsRequest<{id: string}>(harness, owner.token)
			.post(`/guilds/${guild.id}/channels`)
			.body({name: 'deferred', type: ChannelTypes.GUILD_FORUM})
			.execute();
		vi.stubEnv('INTEGRATION_GUILD_ID', guild.id);
		vi.stubEnv(
			'INTEGRATION_FORUM_CHANNEL_IDS',
			[forum.id, '111111111111111111', '222222222222222222', '333333333333333333'].join(','),
		);
		vi.stubEnv('FLUXER_THREAD_POLICY_ENABLED', 'true');
		const policies = new Map<string, ThreadPolicy>();
		const policyChannels = new Map<string, bigint>();
		vi.spyOn(ThreadPolicyRepository.prototype, 'set').mockImplementation(async (channel, _user, policy) => {
			if ((policies.get(policy.source)?.version ?? -1) < policy.version) {
				policies.set(policy.source, policy);
				policyChannels.set(policy.source, channel);
			}
		});
		vi.spyOn(ThreadPolicyRepository.prototype, 'list').mockImplementation(async (channel) =>
			[...policies.values()].filter((policy) => policyChannels.get(policy.source) === channel),
		);
		vi.spyOn(ThreadPolicyRepository.prototype, 'hasActiveLock').mockImplementation(async (channel) =>
			[...policies.values()].some(
				(policy) => policyChannels.get(policy.source) === channel && policy.active && policy.kind === 'lock',
			),
		);
		const service = new IntegrationContentService(createApiContext(), new MemoryOperations());
		const request = {
			version: 1,
			request_id: 'request_deferred_create',
			operation_id: 'operation_deferred_create',
			actor_user_id: creator.userId,
			guild_id: guild.id,
			channel_id: forum.id,
			name: 'closed until synchronized',
			content: 'complete starter body',
			defer_open: true,
		};
		const created = (await service.dispatch('rpc.content.v1.thread.create_service', request)) as {
			thread_id: string;
			deferred_open: boolean;
		};
		expect(created.deferred_open).toBe(true);
		const repository = new ChannelRepository();
		expect(await repository.threads.getState(createChannelID(BigInt(created.thread_id)))).toMatchObject({
			locked: true,
			archived: true,
			externalLocked: true,
			nativeLocked: false,
			nativeArchived: false,
		});
		expect(
			(
				await repository.messages.getMessage(
					createChannelID(BigInt(created.thread_id)),
					BigInt(created.thread_id) as never,
				)
			)?.content,
		).toBe(request.content);
		const blocked = await threadsRequest(harness, creator.token)
			.post(`/channels/${created.thread_id}/messages`)
			.body({content: 'not open yet'})
			.expect(400)
			.execute();
		expect(blocked).toMatchObject({code: 'THREAD_LOCKED'});
		await service.dispatch('rpc.content.v1.thread.policy_service', {
			version: 1,
			request_id: 'request_release_initial',
			operation_id: 'operation_release_initial',
			actor_user_id: creator.userId,
			guild_id: guild.id,
			thread_id: created.thread_id,
			kind: 'lock',
			source: 'forum_initializing',
			policy_version: 1,
			active: false,
		});
		await threadsRequest(harness, creator.token)
			.post(`/channels/${created.thread_id}/messages`)
			.body({content: 'now open'})
			.execute();
		await service.dispatch('rpc.content.v1.thread.create_service', request);
		expect(await repository.threads.getState(createChannelID(BigInt(created.thread_id)))).toMatchObject({
			locked: false,
			archived: false,
			externalLocked: false,
		});
	});
	it('recovers the same scanned attachment after binding interruption and keeps native pending state closed', async () => {
		const owner = await createTestAccount(harness);
		await ensureSessionStarted(harness, owner.token);
		const guild = await createGuild(harness, owner.token, 'attachment recovery');
		const forum = await threadsRequest<{id: string}>(harness, owner.token)
			.post(`/guilds/${guild.id}/channels`)
			.body({name: 'images', type: ChannelTypes.GUILD_FORUM})
			.execute();
		vi.stubEnv('INTEGRATION_GUILD_ID', guild.id);
		vi.stubEnv(
			'INTEGRATION_FORUM_CHANNEL_IDS',
			[forum.id, '111111111111111111', '222222222222222222', '333333333333333333'].join(','),
		);
		vi.stubEnv('FLUXER_THREAD_POLICY_ENABLED', 'true');
		getConfig().presignedAttachmentUploadsEnabled = true;
		const policies = new Map<string, {channel: bigint; policy: ThreadPolicy}>();
		vi.spyOn(ThreadPolicyRepository.prototype, 'set').mockImplementation(async (channel, user, policy) => {
			policies.set(`${channel}:${user}:${policy.source}`, {channel, policy});
		});
		vi.spyOn(ThreadPolicyRepository.prototype, 'list').mockImplementation(async (channel) =>
			[...policies.values()].filter((item) => item.channel === channel).map((item) => item.policy),
		);
		vi.spyOn(ThreadPolicyRepository.prototype, 'hasActiveLock').mockImplementation(async (channel) =>
			[...policies.values()].some(
				(item) => item.channel === channel && item.policy.active && item.policy.kind === 'lock',
			),
		);
		const operations = new MemoryOperations();
		vi.spyOn(IntegrationOperationRepository.prototype, 'allocate').mockImplementation(async (record) => {
			const existing = operations.records.get(record.operation_id);
			if (existing && existing.fingerprint !== record.fingerprint)
				throw new IntegrationError('OPERATION_CONFLICT', 'attachment plan changed');
			return existing ?? operations.allocate(record);
		});
		vi.spyOn(IntegrationOperationRepository.prototype, 'find').mockImplementation(
			async (id) => operations.records.get(id) ?? null,
		);
		let interruptManifestSave = false;
		vi.spyOn(IntegrationOperationRepository.prototype, 'completeOnce').mockImplementation(async (id, result) => {
			if (interruptManifestSave) {
				interruptManifestSave = false;
				throw new Error('manifest save interrupted');
			}
			const record = operations.records.get(id)!;
			if (!record.result) record.result = JSON.stringify(result);
			return JSON.parse(record.result);
		});
		const bytes = loadFixture('yeah.png');
		const upload = await threadsRequest<{
			attachments: Array<{
				id: number;
				filename: string;
				file_size: number;
				content_type: string;
				upload_filename: string;
			}>;
		}>(harness, owner.token)
			.post(`/channels/${forum.id}/attachments`)
			.body({attachments: [{id: 0, filename: 'cover.png', file_size: bytes.length, content_type: 'image/png'}]})
			.execute();
		const {id, filename, file_size, content_type, upload_filename} = upload.attachments[0]!;
		const descriptor = {id, filename, file_size, content_type, upload_filename};
		await harness.storageService.uploadObject({
			bucket: Config.s3.buckets.uploads,
			key: descriptor.upload_filename,
			body: bytes,
			contentType: 'image/png',
		});
		const copy = vi.spyOn(
			AttachmentProcessingService.prototype as unknown as {
				storeAttachmentObject(params: {destinationKey: string}): Promise<unknown>;
			},
			'storeAttachmentObject',
		);
		const binding = AttachmentUploadTraceRepository.prototype.bindAttachment;
		vi.spyOn(AttachmentUploadTraceRepository.prototype, 'bindAttachment')
			.mockRejectedValueOnce(new Error('binding interrupted'))
			.mockImplementation(binding);
		const service = new IntegrationContentService(createApiContext(), operations);
		const request = {
			version: 1,
			request_id: 'request_attachment_recovery',
			operation_id: 'operation_attachment_recovery',
			actor_user_id: owner.userId,
			guild_id: guild.id,
			channel_id: forum.id,
			name: 'cover',
			content: 'image body',
			attachments: [descriptor],
		};
		await expect(service.dispatch('rpc.content.v1.thread.create_service', request)).rejects.toThrow(
			'binding interrupted',
		);
		const plan = JSON.parse(operations.records.get(request.operation_id)!.payload).operation_plan;
		const pending = await threadsRequest<{thread_metadata: {locked: boolean; archived: boolean}}>(harness, owner.token)
			.get(`/channels/${plan.thread_id}`)
			.execute();
		expect(pending.thread_metadata).toMatchObject({locked: true, archived: true});
		await threadsRequest(harness, owner.token)
			.post(`/channels/${plan.thread_id}/messages`)
			.body({content: 'premature'})
			.expect(403)
			.execute();
		await harness.storageService.deleteObject(Config.s3.buckets.uploads, descriptor.upload_filename);
		const recovered = (await service.dispatch('rpc.content.v1.thread.create_service', request)) as {thread_id: string};
		expect(recovered.thread_id).toBe(plan.thread_id);
		expect(copy).toHaveBeenCalledTimes(1);
		const starter = await threadsRequest<{content: string; attachments: Array<{id: string; filename: string}>}>(
			harness,
			owner.token,
		)
			.get(`/channels/${recovered.thread_id}/messages/${recovered.thread_id}`)
			.execute();
		expect(starter.attachments).toHaveLength(1);
		expect(starter.attachments[0]!.filename).toBe('cover.png');
		const opened = await threadsRequest<{thread_metadata: {locked: boolean; archived: boolean}}>(harness, owner.token)
			.get(`/channels/${recovered.thread_id}`)
			.execute();
		expect(opened.thread_metadata).toMatchObject({locked: false, archived: false});
		const extraUpload = await threadsRequest<{attachments: Array<typeof descriptor>}>(harness, owner.token)
			.post(`/channels/${recovered.thread_id}/attachments`)
			.body({attachments: [{id: 0, filename: 'first.png', file_size: bytes.length, content_type: 'image/png'}]})
			.execute();
		const extraRaw = extraUpload.attachments[0]!;
		const extra = {
			id: extraRaw.id,
			filename: extraRaw.filename,
			file_size: extraRaw.file_size,
			content_type: extraRaw.content_type,
			upload_filename: extraRaw.upload_filename,
		};
		await harness.storageService.uploadObject({
			bucket: Config.s3.buckets.uploads,
			key: extra.upload_filename,
			body: bytes,
			contentType: 'image/png',
		});
		const orderedEdit = {
			version: 1,
			request_id: 'request_attachment_order',
			operation_id: 'operation_attachment_order',
			actor_user_id: owner.userId,
			guild_id: guild.id,
			thread_id: recovered.thread_id,
			attachments: [extra, {id: starter.attachments[0]!.id}],
		};
		interruptManifestSave = true;
		await expect(service.dispatch('rpc.content.v1.starter.edit_service', orderedEdit)).rejects.toThrow(
			'manifest save interrupted',
		);
		const firstDestination = copy.mock.calls.at(-1)![0].destinationKey;
		await service.dispatch('rpc.content.v1.starter.edit_service', orderedEdit);
		expect(copy.mock.calls.at(-1)![0].destinationKey).toBe(firstDestination);
		const reordered = await threadsRequest<{attachments: Array<{filename: string}>}>(harness, owner.token)
			.get(`/channels/${recovered.thread_id}/messages/${recovered.thread_id}`)
			.execute();
		expect(reordered.attachments.map((attachment) => attachment.filename)).toEqual(['first.png', 'cover.png']);

		await service.dispatch('rpc.content.v1.starter.edit_service', {
			version: 1,
			request_id: 'request_attachment_remove',
			operation_id: 'operation_attachment_remove',
			actor_user_id: owner.userId,
			guild_id: guild.id,
			thread_id: recovered.thread_id,
			attachments: [],
		});
		const removed = await threadsRequest<{content: string; attachments: Array<unknown>}>(harness, owner.token)
			.get(`/channels/${recovered.thread_id}/messages/${recovered.thread_id}`)
			.execute();
		expect(removed.content).toBe('image body');
		expect(removed.attachments ?? []).toHaveLength(0);
		const rejectedUpload = await threadsRequest<{attachments: Array<typeof descriptor>}>(harness, owner.token)
			.post(`/channels/${forum.id}/attachments`)
			.body({attachments: [{id: 0, filename: 'rejected.png', file_size: bytes.length, content_type: 'image/png'}]})
			.execute();
		const rejectedRaw = rejectedUpload.attachments[0]!;
		const rejected = {
			id: rejectedRaw.id,
			filename: rejectedRaw.filename,
			file_size: rejectedRaw.file_size,
			content_type: rejectedRaw.content_type,
			upload_filename: rejectedRaw.upload_filename,
		};
		await harness.storageService.uploadObject({
			bucket: Config.s3.buckets.uploads,
			key: rejected.upload_filename,
			body: bytes,
			contentType: 'image/png',
		});
		vi.spyOn(AttachmentUploadTraceRepository.prototype, 'bindAttachment').mockResolvedValue(null);
		const terminal = {...request, operation_id: 'operation_attachment_terminal', attachments: [rejected]};
		await expect(service.dispatch('rpc.content.v1.thread.create_service', terminal)).rejects.toMatchObject({
			retryable: false,
		});
		const terminalPlan = JSON.parse(operations.records.get(terminal.operation_id)!.payload).operation_plan;
		await threadsRequest(harness, owner.token).get(`/channels/${terminalPlan.thread_id}`).expect(404).execute();
		await expect(service.dispatch('rpc.content.v1.thread.create_service', terminal)).rejects.toMatchObject({
			retryable: false,
		});
		expect(await new ChannelRepository().threads.listParentThreads(createChannelID(BigInt(forum.id)))).toHaveLength(1);
	});
});
