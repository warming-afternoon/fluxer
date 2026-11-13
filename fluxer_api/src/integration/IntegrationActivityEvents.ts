// SPDX-License-Identifier: AGPL-3.0-or-later

import {randomUUID} from 'node:crypto';
import type {ChannelID} from '@app/api/BrandedTypes';
import {ChannelRepository} from '@app/api/channel/ChannelRepository';
import {Logger} from '@app/api/Logger';
import {IntegrationEventJournal} from '@app/integration/IntegrationEventJournal';

export interface ActivityEmoji {
	/** 自定义表情标识，Unicode 表情为空 */
	id: string | null;

	/** 表情名称或 Unicode 内容 */
	name: string;

	/** 已知的动画标记，活动元数据不覆盖权威展示列表 */
	animated: boolean;
}

export interface ReactionActivityMetadata {
	/** 本次操作对应的稳定表情身份 */
	emoji: ActivityEmoji;

	/** 单用户增减或该表情组清空，两者均使用有符号增量 */
	operation: 'delta' | 'clear_emoji';
}

export interface PreparedActivity {
	/** 持久投递与消费去重使用的事件标识 */
	event_id: string;

	/** 观察原生操作开始时的时间，重试投递不改写 */
	occurred_at: string;

	/** 允许同步的原生服务器标识 */
	guild_id: string;

	/** 原生帖子所属的论坛频道标识 */
	channel_id: string;

	/** 活动发生的原生帖子标识 */
	thread_id: string;

	/** 单表情计数或非首帖消息计数 */
	metric: 'reaction' | 'reply';

	/** 操作前观察到的有符号数量变化，不代表作品总点赞变化 */
	delta: number;

	/** 表情活动独有的身份与操作元数据 */
	reaction?: ReactionActivityMetadata;

	/** 尚需经过原生创建完成闸门的操作标识 */
	creation_operation_id?: string;
}

interface ReactionActivityGroup {
	/** 同组反应对应的表情身份 */
	emoji: ActivityEmoji;

	/** 操作前观察到的该表情反应行数 */
	count: number;
}

/** 观察原生操作前的存在状态，并准备允许少量并发偏差的活动增量 */
export async function prepareIntegrationActivity(
	threadId: ChannelID,
	metric: 'reaction' | 'reply',
	readDelta: () => Promise<number>,
	reaction?: ReactionActivityMetadata,
): Promise<PreparedActivity | null> {
	const occurredAt = new Date().toISOString();
	try {
		// 先限制服务器与论坛范围，避免普通实例和无关频道增加统计查询。
		const state = await new ChannelRepository().threads.getState(threadId);
		const forums = (process.env.INTEGRATION_FORUM_CHANNEL_IDS ?? '').split(',');
		if (
			!state ||
			state.guildId.toString() !== process.env.INTEGRATION_GUILD_ID ||
			!forums.includes(state.parentId.toString())
		) {
			return null;
		}

		// 重复操作的观察增量为零，不为其生成持久活动事件。
		const delta = await readDelta();
		if (!Number.isSafeInteger(delta) || delta === 0) return null;
		const resource = await new IntegrationEventJournal().resource(`thread:${threadId}`);
		return {
			event_id: randomUUID(),
			occurred_at: occurredAt,
			guild_id: state.guildId.toString(),
			channel_id: state.parentId.toString(),
			thread_id: threadId.toString(),
			metric,
			delta,
			reaction,
			...(typeof resource?.creation_operation_id === 'string'
				? {creation_operation_id: resource.creation_operation_id}
				: {}),
		};
	} catch (error) {
		Logger.warn(
			{err: error, threadId: threadId.toString(), metric},
			'Activity observation failed; growth may be incomplete',
		);
		return null;
	}
}

/** 持久化成功原生操作的活动，不将统计入队故障改报为原生请求失败 */
export async function finishIntegrationActivity(activity: PreparedActivity): Promise<void> {
	try {
		// 活动不携带快照版本，避免逐次增量被旧快照淘汰规则跳过。
		const {reaction, ...data} = activity;
		await new IntegrationEventJournal().enqueue(
			'events.content.v1.thread.activity',
			{
				...data,
				...reaction,
				schema_version: 1,
				kind: 'activity.delta',
				platform: 'fluxer',
				source_time_quality: 'operation',
				creation_completed: true,
			},
			activity.event_id,
			activity.occurred_at,
		);
	} catch (error) {
		// 原生写与入队仍有双写窗口，快照只能修总量，不能补造历史日增长。
		Logger.error(
			{err: error, eventId: activity.event_id, threadId: activity.thread_id},
			'Activity enqueue failed after native write; growth may be incomplete',
		);
	}
}

/** 清空时复用一次原生列表观察，按稳定表情身份准备各组负增量 */
export async function prepareIntegrationReactionClear(
	threadId: ChannelID,
	readReactions: () => Promise<Array<ActivityEmoji>>,
): Promise<Array<PreparedActivity>> {
	let rows: Array<ActivityEmoji> = [];
	const base = await prepareIntegrationActivity(threadId, 'reaction', async () => {
		rows = await readReactions();
		return -rows.length;
	});
	if (!base) return [];

	// 自定义表情按标识归组，Unicode 表情按内容归组，不发送所有表情的总增量。
	const groups = new Map<string, ReactionActivityGroup>();
	for (const emoji of rows) {
		const key = emoji.id ? `id:${emoji.id}` : `name:${emoji.name}`;
		const group = groups.get(key);
		if (group) {
			group.count++;
		} else {
			groups.set(key, {emoji, count: 1});
		}
	}
	return [...groups.values()].map(({emoji, count}) => ({
		...base,
		event_id: randomUUID(),
		delta: -count,
		reaction: {emoji, operation: 'clear_emoji'},
	}));
}
