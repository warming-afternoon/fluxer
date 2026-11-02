// SPDX-License-Identifier: AGPL-3.0-or-later

import {createChannelID, createGuildID, createUserID} from '@app/api/BrandedTypes';
import {ChannelRepository} from '@app/api/channel/ChannelRepository';
import {ThreadMoveRepository} from '@app/api/channel/repositories/ThreadMoveRepository';
import {ThreadMoveService} from '@app/api/channel/services/thread/ThreadMoveService';
import {
	executeConditional,
	fetchMany,
	setCassandraQueryExecutorForTesting,
	upsertOne,
} from '@app/api/database/CassandraQueryExecution';
import {Db} from '@app/api/database/CassandraTypes';
import type {ChannelRow} from '@app/api/database/types/ChannelTypes';
import {Channels, ThreadMembersByUser, ThreadState, ThreadsByParent} from '@app/api/Tables';
import {InMemoryCassandraQueryExecutor} from '@app/api/test/InMemoryCassandraQueryExecutor';
import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import {ChannelFlags} from '@fluxer/constants/src/ThreadConstants';
import {InvalidChannelTypeError} from '@fluxer/errors/src/domains/channel/InvalidChannelTypeError';
import {UnknownChannelError} from '@fluxer/errors/src/domains/channel/UnknownChannelError';
import {InputValidationError} from '@fluxer/errors/src/domains/core/InputValidationError';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const guild = createGuildID(1900000000000000000n);
const source = createChannelID(1900000000000000001n);
const target = createChannelID(1900000000000000002n);
const thread = createChannelID(1900000000000000003n);
const member = createUserID(1900000000000000004n);

/** 提供完整频道行，防止测试依赖生产模型的缺省值。 */
function channelRow(id: typeof source, type: number): ChannelRow {
	return {
		channel_id: id,
		guild_id: guild,
		type,
		name: '移动测试',
		topic: null,
		icon_hash: null,
		url: null,
		parent_id: null,
		position: 0,
		owner_id: member,
		recipient_ids: null,
		nsfw: false,
		content_warning_level: null,
		content_warning_text: null,
		rate_limit_per_user: 0,
		bitrate: null,
		user_limit: null,
		voice_connection_limit: null,
		rtc_region: null,
		rtc_p2p: null,
		last_message_id: null,
		last_pin_timestamp: null,
		permission_overwrites: null,
		nicks: null,
		soft_deleted: false,
		indexed_at: null,
		version: 1,
	};
}

describe('跨论坛移动的持久索引与恢复', () => {
	let repository: ChannelRepository;
	let moves: ThreadMoveRepository;
	let executor: InMemoryCassandraQueryExecutor;
	beforeEach(async () => {
		executor = new InMemoryCassandraQueryExecutor();
		setCassandraQueryExecutorForTesting(executor);
		repository = new ChannelRepository();
		moves = new ThreadMoveRepository(repository);
		await upsertOne(Channels.upsertAll(channelRow(source, ChannelTypes.GUILD_FORUM)));
		await upsertOne(Channels.upsertAll(channelRow(target, ChannelTypes.GUILD_FORUM)));
		await repository.threads.create({
			channel: {...channelRow(thread, ChannelTypes.PUBLIC_THREAD), parent_id: source},
			parentType: ChannelTypes.GUILD_FORUM,
			autoArchiveDuration: 1440,
			invitable: null,
			flags: ChannelFlags.PINNED,
			appliedTags: [10n],
			hasStarter: true,
			createdAt: new Date(),
			members: [{userId: member, flags: 1}],
		});
		await repository.threads.claimForumPin(source, thread);
	});
	afterEach(() => setCassandraQueryExecutorForTesting(null));

	it('保持帖子身份并移动成员、父目录和活跃索引，重试不重复增加成员', async () => {
		const input = {threadId: thread, sourceParentId: source, targetParentId: target, appliedTags: [20n]};
		await moves.move(input);
		const state = await moves.move(input);
		expect(state.parentId).toBe(target);
		expect(state.memberCount).toBe(1);
		expect(state.appliedTags).toEqual([20n]);
		expect(state.isPinned).toBe(false);
		expect((await repository.channelData.findUnique(thread))?.parentId).toBe(target);
		expect((await repository.threads.getMember(thread, member))?.parentId).toBe(target);
		expect(await repository.threads.getForumPin(source)).toBeNull();
		expect(await repository.threads.listParentThreads(source)).toEqual([]);
		expect(await repository.threads.listParentThreads(target)).toEqual([
			{threadId: thread, type: ChannelTypes.PUBLIC_THREAD},
		]);
		const rows = await fetchMany(
			ThreadMembersByUser.select({where: ThreadMembersByUser.where.eq('user_id')}).bind({user_id: member}),
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.parent_id).toBe(target);
	});

	it('删除准备已经冻结的帖子不能再移动或重写父目录', async () => {
		const state = (await repository.threads.getState(thread))!;
		await repository.threads.beginDelete(thread, state.stateVersion, 'move-delete-ticket');
		await expect(
			moves.move({threadId: thread, sourceParentId: source, targetParentId: target, appliedTags: []}),
		).rejects.toBeInstanceOf(UnknownChannelError);
		expect((await repository.threads.getState(thread))?.parentId).toBe(source);
		expect((await repository.channelData.findUnique(thread))?.parentId).toBe(source);
		expect(await repository.threads.listParentThreads(target)).toEqual([]);
	});

	it('删除完成后迟到的移动索引不能重新暴露已删除帖子', async () => {
		const execute = executor.executeBatch.bind(executor);
		let injected = false;
		vi.spyOn(executor, 'executeBatch').mockImplementation(async (queries, atomic) => {
			if (
				!injected &&
				queries.some((query) => query.meta?.table.name === 'threads_by_parent' && query.meta?.action === 'upsert')
			) {
				injected = true;
				const state = (await repository.threads.getState(thread))!;
				await repository.threads.beginDelete(thread, state.stateVersion, 'during-move');
				await repository.threads.markDeleteDispatched(thread, 'during-move');
				await repository.threads.purgeThread(thread);
			}
			await execute(queries, atomic);
		});
		await expect(
			moves.move({threadId: thread, sourceParentId: source, targetParentId: target, appliedTags: []}),
		).rejects.toBeInstanceOf(UnknownChannelError);
		expect(injected).toBe(true);
		expect(await repository.threads.getState(thread)).toBeNull();
		expect(await repository.channelData.findUnique(thread)).toBeNull();
		expect(await repository.threads.listParentThreads(target)).toEqual([]);
		expect(await repository.threads.listActiveThreads(guild)).toEqual([]);
		expect(await repository.threads.listMembers(thread, {limit: 10})).toEqual([]);
	});

	it('归档帖子留在归档状态并从旧论坛归档列表消失', async () => {
		await repository.threads.updateState(thread, () => ({archived: true, locked: true}));
		const state = await moves.move({threadId: thread, sourceParentId: source, targetParentId: target, appliedTags: []});
		expect(state.archived).toBe(true);
		expect(state.locked).toBe(true);
		expect((await repository.threads.listArchivedThreads(source, false, {limit: 10})).threads).toEqual([]);
		expect(
			(await repository.threads.listArchivedThreads(target, false, {limit: 10})).threads.map((item) => item.threadId),
		).toEqual([thread]);
		expect(await repository.threads.listActiveThreads(guild)).toEqual([]);
	});

	it('权威父引用已提交而索引未完成时，同操作重试能修复', async () => {
		await executeConditional(
			ThreadState.conditionalPatchByPk(
				{thread_id: thread},
				{parent_id: Db.set(target), state_version: Db.set(2)},
				{state_version: 1},
			),
		);
		await moves.move({threadId: thread, sourceParentId: source, targetParentId: target, appliedTags: []});
		expect((await repository.channelData.findUnique(thread))?.parentId).toBe(target);
		const oldRows = await fetchMany(
			ThreadsByParent.select({where: ThreadsByParent.where.eq('parent_id')}).bind({parent_id: source}),
		);
		expect(oldRows).toEqual([]);
		expect((await repository.threads.getMember(thread, member))?.parentId).toBe(target);
	});

	it('过期操作不能把已移到其他论坛的帖子移回', async () => {
		await moves.move({threadId: thread, sourceParentId: source, targetParentId: target, appliedTags: []});
		await expect(
			moves.move({threadId: thread, sourceParentId: source, targetParentId: createChannelID(999n), appliedTags: []}),
		).rejects.toThrow('beyond this operation');
		expect((await repository.threads.getState(thread))?.parentId).toBe(target);
	});

	it('加入成员在读取旧父论坛之后遇到移动，最终正反索引都指向新论坛', async () => {
		const joining = createUserID(1900000000000000009n);
		const getMembers = repository.threads.getMembers.bind(repository.threads);
		vi.spyOn(repository.threads, 'getMembers').mockImplementationOnce(async (id, users) => {
			const result = await getMembers(id, users);
			await moves.move({threadId: thread, sourceParentId: source, targetParentId: target, appliedTags: []});
			return result;
		});
		const result = await repository.threads.addMembers(thread, [{userId: joining, flags: 0}]);
		expect(result?.added[0]?.parentId).toBe(target);
		expect((await repository.threads.getMember(thread, joining))?.parentId).toBe(target);
		const rows = await fetchMany(
			ThreadMembersByUser.select({where: ThreadMembersByUser.where.eq('user_id')}).bind({user_id: joining}),
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.parent_id).toBe(target);
	});

	it.each(['leave', 'rejoin', 'rejoin-source'] as const)('迟到旧加入反向目录按当前成员收敛：%s', async (mode) => {
		const joining = createUserID(1900000000000000099n);
		const getMembers = repository.threads.getMembers.bind(repository.threads);
		vi.spyOn(repository.threads, 'getMembers').mockImplementationOnce(async (id, users) => {
			const result = await getMembers(id, users);
			await moves.move({threadId: thread, sourceParentId: source, targetParentId: target, appliedTags: []});
			return result;
		});
		const execute = executor.executeBatch.bind(executor);
		let injected = false;
		let newJoin: Date | undefined;
		vi.spyOn(executor, 'executeBatch').mockImplementation(async (queries, atomic) => {
			if (
				!injected &&
				queries.some(
					(query) =>
						query.meta?.table.name === 'thread_members_by_user' &&
						query.meta.action === 'upsert' &&
						(query.params as {user_id?: bigint}).user_id === joining &&
						(query.params as {parent_id?: bigint}).parent_id === source,
				)
			) {
				injected = true;
				await repository.threads.removeMembers(thread, [joining]);
				if (mode !== 'leave') {
					if (mode === 'rejoin-source')
						await moves.move({threadId: thread, sourceParentId: target, targetParentId: source, appliedTags: []});
					await new Promise((resolve) => setTimeout(resolve, 5));
					await repository.threads.addMembers(thread, [{userId: joining, flags: 0}]);
					newJoin = (await repository.threads.getMember(thread, joining))!.joinTimestamp;
				}
			}
			await execute(queries, atomic);
		});
		await repository.threads.addMembers(thread, [{userId: joining, flags: 0}]);
		expect(injected).toBe(true);
		const member = await repository.threads.getMember(thread, joining);
		const reverse = await fetchMany(
			ThreadMembersByUser.select({where: ThreadMembersByUser.where.eq('user_id')}).bind({user_id: joining}),
		);
		if (mode === 'leave') {
			expect(member).toBeNull();
			expect(reverse).toEqual([]);
		} else {
			expect(member?.joinTimestamp).toEqual(newJoin);
			expect(member?.parentId).toBe(mode === 'rejoin-source' ? source : target);
			expect(reverse.map((row) => row.parent_id)).toEqual([member!.parentId]);
		}
	});

	it('清理旧位置期间移回原论坛，重读后补回合法的当前目录', async () => {
		const joining = createUserID(1900000000000000098n);
		const getMembers = repository.threads.getMembers.bind(repository.threads);
		vi.spyOn(repository.threads, 'getMembers').mockImplementationOnce(async (id, users) => {
			const result = await getMembers(id, users);
			await moves.move({threadId: thread, sourceParentId: source, targetParentId: target, appliedTags: []});
			return result;
		});
		const execute = executor.executeBatch.bind(executor);
		let injected = false;
		vi.spyOn(executor, 'executeBatch').mockImplementation(async (queries, atomic) => {
			if (
				!injected &&
				queries.some(
					(query) =>
						query.meta?.table.name === 'thread_members_by_user' &&
						query.meta.action === 'delete' &&
						(query.params as {user_id?: bigint}).user_id === joining &&
						(query.params as {parent_id?: bigint}).parent_id === source,
				)
			) {
				injected = true;
				await moves.move({threadId: thread, sourceParentId: target, targetParentId: source, appliedTags: []});
			}
			await execute(queries, atomic);
		});
		await repository.threads.addMembers(thread, [{userId: joining, flags: 0}]);
		expect(injected).toBe(true);
		expect((await repository.threads.getMember(thread, joining))?.parentId).toBe(source);
		const reverse = await fetchMany(
			ThreadMembersByUser.select({where: ThreadMembersByUser.where.eq('user_id')}).bind({user_id: joining}),
		);
		expect(reverse.map((row) => row.parent_id)).toEqual([source]);
	});

	it('删除期间迟到的目标反向目录按全部已观察位置清理', async () => {
		const joining = createUserID(1900000000000000097n);
		const getMembers = repository.threads.getMembers.bind(repository.threads);
		vi.spyOn(repository.threads, 'getMembers').mockImplementationOnce(async (id, users) => {
			const result = await getMembers(id, users);
			await moves.move({threadId: thread, sourceParentId: source, targetParentId: target, appliedTags: []});
			return result;
		});
		const execute = executor.executeBatch.bind(executor);
		let injected = false;
		vi.spyOn(executor, 'executeBatch').mockImplementation(async (queries, atomic) => {
			if (
				!injected &&
				queries.some(
					(query) =>
						query.meta?.table.name === 'thread_members_by_user' &&
						query.meta.action === 'upsert' &&
						(query.params as {user_id?: bigint}).user_id === joining &&
						(query.params as {parent_id?: bigint}).parent_id === target,
				)
			) {
				injected = true;
				const state = (await repository.threads.getState(thread))!;
				await repository.threads.beginDelete(thread, state.stateVersion, 'late-target-repair-delete');
				await repository.threads.markDeleteDispatched(thread, 'late-target-repair-delete');
				await repository.threads.purgeThread(thread);
			}
			await execute(queries, atomic);
		});
		await expect(repository.threads.addMembers(thread, [{userId: joining, flags: 0}])).rejects.toBeInstanceOf(
			UnknownChannelError,
		);
		expect(injected).toBe(true);
		expect(await repository.threads.getState(thread)).toBeNull();
		expect(await repository.threads.getMember(thread, joining)).toBeNull();
		const reverse = await fetchMany(
			ThreadMembersByUser.select({where: ThreadMembersByUser.where.eq('user_id')}).bind({user_id: joining}),
		);
		expect(reverse).toEqual([]);
	});

	it('外部锁投影真实归档状态，解除后恢复原先活动状态', async () => {
		const locked = await repository.threads.projectExternalLock(thread, true);
		expect(locked?.state.locked).toBe(true);
		expect(locked?.state.archived).toBe(true);
		expect(locked?.state.nativeLocked).toBe(false);
		expect(locked?.state.nativeArchived).toBe(false);
		expect(await repository.threads.listActiveThreads(guild)).toEqual([]);
		const restored = await repository.threads.projectExternalLock(thread, false);
		expect(restored?.state.locked).toBe(false);
		expect(restored?.state.archived).toBe(false);
		expect((await repository.threads.listActiveThreads(guild)).map((item) => item.threadId)).toEqual([thread]);
	});

	it('外部锁生效时管理员再次锁定，解除外部锁不能解除该原生限制', async () => {
		await repository.threads.projectExternalLock(thread, true);
		await repository.threads.updateState(thread, () => ({locked: true, archived: true}));
		const restored = await repository.threads.projectExternalLock(thread, false);
		expect(restored?.state.locked).toBe(true);
		expect(restored?.state.archived).toBe(true);
		expect(restored?.state.nativeLocked).toBe(true);
	});

	it('普通状态修改不会绕过仍然生效的外部锁，且恢复保留原有归档', async () => {
		await repository.threads.updateState(thread, () => ({archived: true}));
		await repository.threads.projectExternalLock(thread, true);
		await repository.threads.updateState(thread, () => ({locked: false}));
		expect((await repository.threads.getState(thread))?.locked).toBe(true);
		await moves.move({threadId: thread, sourceParentId: source, targetParentId: target, appliedTags: []});
		const restored = await repository.threads.projectExternalLock(thread, false);
		expect(restored?.state.locked).toBe(false);
		expect(restored?.state.archived).toBe(true);
		expect(restored?.state.parentId).toBe(target);
	});

	it('目标论坛缺少唯一标签映射时拒绝移动，不静默丢失原生标签', async () => {
		const service = new ThreadMoveService({channelRepository: repository} as ConstructorParameters<
			typeof ThreadMoveService
		>[0]);
		await expect(
			service.move({
				threadId: thread,
				sourceParentId: source,
				targetParentId: target,
				userId: member,
				auditLogReason: null,
			}),
		).rejects.toBeInstanceOf(InputValidationError);
		expect((await repository.threads.getState(thread))?.parentId).toBe(source);
		expect((await repository.threads.getState(thread))?.appliedTags).toEqual([10n]);
	});

	it('跨服务器移动在任何持久副作用之前被拒绝', async () => {
		await upsertOne(
			Channels.upsertAll({...channelRow(target, ChannelTypes.GUILD_FORUM), guild_id: createGuildID(99n)}),
		);
		const service = new ThreadMoveService({channelRepository: repository} as ConstructorParameters<
			typeof ThreadMoveService
		>[0]);
		await expect(
			service.move({
				threadId: thread,
				sourceParentId: source,
				targetParentId: target,
				userId: member,
				auditLogReason: null,
			}),
		).rejects.toBeInstanceOf(InvalidChannelTypeError);
		expect((await repository.threads.getState(thread))?.parentId).toBe(source);
	});
});
