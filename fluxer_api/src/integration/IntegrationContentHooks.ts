// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ChannelID} from '@app/api/BrandedTypes';
import type {
	ActivityEmoji,
	PreparedActivity,
	ReactionActivityMetadata,
} from '@app/integration/IntegrationActivityEvents';
import type {ContentResource} from '@app/integration/IntegrationContentEvents';

/** 写入前持久化原生资源意图，不向未启用集成的实例加载外部依赖 */
export async function prepareIntegrationContentChange(
	threadId: ChannelID,
	resource?: ContentResource,
	deleting = false,
): Promise<void> {
	if (!process.env.INTEGRATION_NATS_URL) return;
	// 确认集成已启用后才加载事件实现，避免影响普通实例启动。
	const events = await import('@app/integration/IntegrationContentEvents');
	await events.prepareIntegrationContentChange(threadId, resource, deleting);
}

/** 成功写入后读取快照，恢复循环会继续处理未完成资源 */
export async function finishIntegrationContentChange(threadId: ChannelID): Promise<void> {
	if (!process.env.INTEGRATION_NATS_URL) return;
	// 确认集成已启用后才加载事件实现，避免影响普通实例启动。
	const events = await import('@app/integration/IntegrationContentEvents');
	await events.finishIntegrationContentChange(threadId);
}

/** 只为已启用集成的原生帖子准备净变化；不是与原生写入的跨库事务。 */
export async function prepareIntegrationActivity(
	threadId: ChannelID,
	metric: 'reaction' | 'reply',
	readDelta: () => Promise<number>,
	reaction?: ReactionActivityMetadata,
): Promise<PreparedActivity | null> {
	if (!process.env.INTEGRATION_NATS_URL) return null;
	// 延迟加载实现，未启用集成时不读取原生计数。
	const events = await import('@app/integration/IntegrationActivityEvents');
	return events.prepareIntegrationActivity(threadId, metric, readDelta, reaction);
}

/** 原生操作成功后持久化；发送失败由现有 journal 恢复，入队失败只能对账总量。 */
export async function finishIntegrationActivity(activity: PreparedActivity | null): Promise<void> {
	if (!activity) return;
	// 复用现有持久投递链路，避免在原生请求内等待远端消费。
	const events = await import('@app/integration/IntegrationActivityEvents');
	await events.finishIntegrationActivity(activity);
}

/** 清空首帖反应时保持每种表情的独立计数，不把总行数当作品点赞数。 */
export async function prepareIntegrationReactionClear(
	threadId: ChannelID,
	readReactions: () => Promise<Array<ActivityEmoji>>,
): Promise<Array<PreparedActivity>> {
	if (!process.env.INTEGRATION_NATS_URL) return [];
	// 管理清空操作需要分组观察，普通增删不经过该列表查询。
	const events = await import('@app/integration/IntegrationActivityEvents');
	return events.prepareIntegrationReactionClear(threadId, readReactions);
}
