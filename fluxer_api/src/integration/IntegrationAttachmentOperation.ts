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

// 附件恢复能力只在当前异步调用链内传播。
const operation = new AsyncLocalStorage<AttachmentOperationScope>();

/** 只有受信内容 RPC 能设置附件恢复上下文，浏览器请求不能注入此能力 */
export function withIntegrationAttachmentOperation<T>(
	operationId: string,
	apply: () => Promise<T>,
	target?: {channelId: string; messageId: string},
): Promise<T> {
	// 将可信操作及目标绑定到调用链，避免并发请求串用附件计划。
	return operation.run({operationId, ...target}, apply);
}

/** 原生附件管线读取当前持久操作标识，普通消息保持现有行为 */
export function currentIntegrationAttachmentOperation(): string | undefined {
	// 普通请求没有上下文，返回空值以保持原生管线行为。
	return operation.getStore()?.operationId;
}

/** 仅为恢复原生预上传校验提供已授权目标，不允许跨频道复用准备结果 */
export function currentIntegrationAttachmentScope(): AttachmentOperationScope | undefined {
	// 返回当前调用链的完整目标，供恢复流程校验上传范围。
	return operation.getStore();
}
