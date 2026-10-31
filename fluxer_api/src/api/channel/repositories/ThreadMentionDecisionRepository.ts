// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ChannelID, MessageID} from '@app/api/BrandedTypes';
import {
	type ThreadMentionDecision,
	ThreadMentionDecisionSchema,
	type ThreadMentionWarning,
} from '@app/api/channel/services/message/ThreadMentionDecision';
import {
	type BatchBuilder,
	deleteOneOrMany,
	executeConditional,
	fetchManyInChunks,
	fetchOne,
} from '@app/api/database/CassandraQueryExecution';
import {defineTable} from '@app/api/database/CassandraTableDsl';

interface DecisionRow {
	channel_id: ChannelID;
	message_id: MessageID;
	decision_text: string;
	warnings: string;
}

const Decisions = defineTable<DecisionRow, 'channel_id' | 'message_id', 'channel_id'>({
	name: 'thread_message_mention_decisions',
	columns: ['channel_id', 'message_id', 'decision_text', 'warnings'],
	primaryKey: ['channel_id', 'message_id'],
	partitionKey: ['channel_id'],
});

/** 保存消息绑定的决策，后台重试不重新展开角色。 */
export class ThreadMentionDecisionRepository {
	/** 与消息删除使用同一有界批次清理私有决策，避免残留候选名单。 */
	appendMessageDelete(batch: BatchBuilder, channelId: ChannelID, messageId: MessageID): void {
		batch.addPrepared(Decisions.deleteByPk({channel_id: channelId, message_id: messageId}));
	}

	/** 随精确帖子清理私有候选数据，不保留已删除成员关系。 */
	async deleteForThread(channelId: ChannelID): Promise<void> {
		await deleteOneOrMany(Decisions.deletePartition({channel_id: channelId}));
	}

	/** 只读取这一条消息的私有决策。 */
	async get(channelId: ChannelID, messageId: MessageID): Promise<ThreadMentionDecision | null> {
		const row = await fetchOne<DecisionRow>(
			Decisions.select({where: [Decisions.where.eq('channel_id'), Decisions.where.eq('message_id')], limit: 1}).bind({
				channel_id: channelId,
				message_id: messageId,
			}),
		);
		return row ? ThreadMentionDecisionSchema.parse(JSON.parse(row.decision_text)) : null;
	}

	/** 并发接纳只能固定一份决策，失败方复用已提交结果。 */
	async insertOnce(
		decision: ThreadMentionDecision,
		channelId: ChannelID,
		messageId: MessageID,
	): Promise<ThreadMentionDecision> {
		const applied = await executeConditional(
			Decisions.conditionalBatch([
				{
					action: 'insert',
					row: {
						channel_id: channelId,
						message_id: messageId,
						decision_text: JSON.stringify(decision),
						warnings: JSON.stringify(decision.warnings),
					},
				},
			]),
		);
		if (applied) return decision;
		const existing = await this.get(channelId, messageId);
		if (!existing) throw new Error('Thread mention decision disappeared after conditional insert');
		return existing;
	}

	/** 历史消息只批量读取提示列，不复制内部候选名单。 */
	async getWarnings(
		channelId: ChannelID,
		messageIds: Array<MessageID>,
	): Promise<Map<string, Array<ThreadMentionWarning>>> {
		const query = Decisions.select({
			columns: ['message_id', 'warnings'],
			where: [
				{col: 'channel_id', kind: 'eq', param: 'channel_id'},
				{col: 'message_id', kind: 'in', param: 'message_ids'},
			],
		});
		const rows = await fetchManyInChunks<Pick<DecisionRow, 'message_id' | 'warnings'>, MessageID>(
			query,
			messageIds,
			(ids) => ({channel_id: channelId, message_ids: ids}),
			100,
		);
		return new Map(
			rows.map((row) => [
				row.message_id.toString(),
				ThreadMentionDecisionSchema.shape.warnings.parse(JSON.parse(row.warnings)),
			]),
		);
	}
}
