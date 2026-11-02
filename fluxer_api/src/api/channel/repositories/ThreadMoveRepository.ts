// SPDX-License-Identifier: AGPL-3.0-or-later

import {type ChannelID, channelIdToMessageId, type UserID} from '@app/api/BrandedTypes';
import type {ChannelRepository} from '@app/api/channel/ChannelRepository';
import {BatchBuilder, deleteOneOrMany, executeConditional, fetchOne} from '@app/api/database/CassandraQueryExecution';
import {Db} from '@app/api/database/CassandraTypes';
import type {ChannelRow} from '@app/api/database/types/ChannelTypes';
import {ThreadState} from '@app/api/models/ThreadState';
import {
	ArchivedThreadsByParent,
	Channels,
	ThreadState as States,
	ThreadMembers,
	ThreadMembersByUser,
	ThreadsByParent,
} from '@app/api/Tables';
import {ChannelFlags} from '@fluxer/constants/src/ThreadConstants';
import {UnknownChannelError} from '@fluxer/errors/src/domains/channel/UnknownChannelError';
import {ServiceUnavailableError} from '@fluxer/errors/src/domains/core/ServiceUnavailableError';

const FETCH_CHANNEL = Channels.select({
	where: [Channels.where.eq('channel_id'), Channels.where.eq('soft_deleted')],
	limit: 1,
});

/** 保留讨论区身份并修复跨父论坛的持久索引；调用方必须串行化同一讨论区的移动操作。 */
export class ThreadMoveRepository {
	/** 复用原生讨论区仓储，所有数据库细节留在仓储层。 */
	constructor(private readonly repository: ChannelRepository) {}

	/** 原父频道必须来自持久操作计划，以便在权威状态已修改而索引未写完时继续修复。 */
	async move(params: {
		/** 原生讨论区 ID，移动过程中不变。 */
		threadId: ChannelID;

		/** 本次操作开始时的父论坛 ID。 */
		sourceParentId: ChannelID;

		/** 已经完成权限与服务器校验的目标父论坛。 */
		targetParentId: ChannelID;

		/** 映射到目标论坛的原生标签 ID。 */
		appliedTags: Array<bigint>;
	}): Promise<ThreadState> {
		const {threadId, sourceParentId, targetParentId, appliedTags} = params;
		for (let attempt = 0; attempt < 5; attempt++) {
			const current = await this.repository.threads.getState(threadId);
			const channel = await fetchOne<ChannelRow>(FETCH_CHANNEL.bind({channel_id: threadId, soft_deleted: false}));
			if (!current || !channel) throw new UnknownChannelError();
			if (current.parentId !== sourceParentId && current.parentId !== targetParentId) {
				throw new Error('Thread has moved beyond this operation');
			}
			let next = current;
			if (current.parentId !== targetParentId) {
				const applied = await executeConditional(
					States.conditionalPatchByPk(
						{thread_id: threadId},
						{
							parent_id: Db.set(targetParentId),
							applied_tags: Db.set(appliedTags),
							flags: Db.set(current.flags & ~ChannelFlags.PINNED),
							state_version: Db.set(current.stateVersion + 1),
						},
						{state_version: current.stateVersion},
					),
				);
				if (!applied) continue;
				next = new ThreadState({
					...current.toRow(),
					parent_id: targetParentId,
					applied_tags: appliedTags,
					flags: current.flags & ~ChannelFlags.PINNED,
					state_version: current.stateVersion + 1,
				});
			}
			// 条件修改现存频道，避免删除并发时通过普通 upsert 复活残缺频道。
			if (
				channel.parent_id !== targetParentId &&
				!(await executeConditional(
					Channels.conditionalPatchByPk(
						{channel_id: threadId, soft_deleted: false},
						{parent_id: Db.set(targetParentId), version: Db.set((channel.version ?? 0) + 1)},
						{version: channel.version ?? 0},
					),
				))
			)
				continue;
			const batch = new BatchBuilder();
			batch.addPrepared(
				ThreadsByParent.upsertAll({
					parent_id: targetParentId,
					thread_id: threadId,
					guild_id: next.guildId,
					type: next.type,
				}),
			);
			if (sourceParentId !== targetParentId) {
				batch.addPrepared(ThreadsByParent.deleteByPk({parent_id: sourceParentId, thread_id: threadId}));
				if (current.archiveTimestamp)
					batch.addPrepared(
						ArchivedThreadsByParent.deleteByPk({
							parent_id: sourceParentId,
							is_private: current.isPrivate,
							archive_timestamp: current.archiveTimestamp,
							thread_id: threadId,
						}),
					);
			}
			await batch.execute(false);
			await this.repository.threads.repairThreadIndexes([threadId]);
			if (sourceParentId !== targetParentId) await this.repository.threads.releaseForumPin(sourceParentId, threadId);
			// 小批量成员修复，不复制消息，也不将全体成员塞入一个跨分区大 batch。
			let after: UserID | undefined;
			for (;;) {
				const members = await this.repository.threads.listMembers(threadId, {after, limit: 64});
				if (members.length === 0) break;
				for (let offset = 0; offset < members.length; offset += 8) {
					await Promise.all(
						members.slice(offset, offset + 8).map(async (member) => {
							const changed = await executeConditional(
								ThreadMembers.conditionalPatchByPk(
									{thread_id: threadId, user_id: member.userId},
									{parent_id: Db.set(targetParentId)},
									{parent_id: member.parentId},
								),
							);
							if (!changed) return;
							const memberBatch = new BatchBuilder();
							if (sourceParentId !== targetParentId)
								memberBatch.addPrepared(
									ThreadMembersByUser.deleteByPk({
										user_id: member.userId,
										guild_id: next.guildId,
										parent_id: sourceParentId,
										is_private: next.isPrivate,
										thread_id: threadId,
									}),
								);
							memberBatch.addPrepared(
								ThreadMembersByUser.upsertAll({
									user_id: member.userId,
									guild_id: next.guildId,
									parent_id: targetParentId,
									is_private: next.isPrivate,
									thread_id: threadId,
								}),
							);
							await memberBatch.execute(false);
							// 移动期间退帖不能由迟到的索引写入留下幽灵成员。
							if (!(await this.repository.threads.getMember(threadId, member.userId))) {
								await deleteOneOrMany(
									ThreadMembersByUser.deleteByPk({
										user_id: member.userId,
										guild_id: next.guildId,
										parent_id: targetParentId,
										is_private: next.isPrivate,
										thread_id: threadId,
									}),
								);
							}
						}),
					);
				}
				after = members[members.length - 1]!.userId;
				if (members.length < 64) break;
			}
			await this.repository.threads.patchParentConfig(next.guildId, targetParentId, {has_threads: true});
			await this.repository.channelData.updateLastMessageId(targetParentId, channelIdToMessageId(threadId));
			// 旧频道尾帖只在仍指向被移动帖时清除，不覆盖并发新帖。
			if (sourceParentId !== targetParentId)
				await executeConditional(
					Channels.conditionalPatchByPk(
						{channel_id: sourceParentId, soft_deleted: false},
						{last_message_id: Db.clear()},
						{last_message_id: channelIdToMessageId(threadId)},
					),
				);
			const latest = await this.repository.threads.getState(threadId);
			if (!latest) throw new UnknownChannelError();
			if (latest.stateVersion !== next.stateVersion) continue;
			return latest;
		}
		throw new ServiceUnavailableError();
	}
}
