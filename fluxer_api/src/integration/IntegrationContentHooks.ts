// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ChannelID} from '@app/api/BrandedTypes';
import type {ContentResource} from '@app/integration/IntegrationContentEvents';

/** 写入前持久化原生资源意图，不向未启用集成的实例加载外部依赖 */
export async function prepareIntegrationContentChange(
	threadId: ChannelID,
	resource?: ContentResource,
	deleting = false,
): Promise<void> {
	if (!process.env.INTEGRATION_NATS_URL) return;
	const events = await import('@app/integration/IntegrationContentEvents');
	await events.prepareIntegrationContentChange(threadId, resource, deleting);
}

/** 成功写入后读取快照，恢复循环会继续处理未完成资源 */
export async function finishIntegrationContentChange(threadId: ChannelID): Promise<void> {
	if (!process.env.INTEGRATION_NATS_URL) return;
	const events = await import('@app/integration/IntegrationContentEvents');
	await events.finishIntegrationContentChange(threadId);
}
