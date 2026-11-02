// SPDX-License-Identifier: AGPL-3.0-or-later

import {AsyncLocalStorage} from 'node:async_hooks';

interface AttachmentOperationScope {
	/** 已持久授权的服务操作 */
	operationId: string;

	/** 已预分配的目标消息频道 */
	channelId?: string;

	/** 已预分配的原生消息 */
	messageId?: string;
}
const operation = new AsyncLocalStorage<AttachmentOperationScope>();

/** 只有受信内容 RPC 能设置附件恢复上下文，浏览器请求不能注入此能力 */
export function withIntegrationAttachmentOperation<T>(
	operationId: string,
	apply: () => Promise<T>,
	target?: {channelId: string; messageId: string},
): Promise<T> {
	return operation.run({operationId, ...target}, apply);
}

/** 原生附件管线读取当前持久操作标识，普通消息保持现有行为 */
export function currentIntegrationAttachmentOperation(): string | undefined {
	return operation.getStore()?.operationId;
}

/** 仅为恢复原生预上传校验提供已授权目标，不允许跨频道复用准备结果 */
export function currentIntegrationAttachmentScope(): AttachmentOperationScope | undefined {
	return operation.getStore();
}
