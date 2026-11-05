// SPDX-License-Identifier: AGPL-3.0-or-later

export class IntegrationError extends Error {
	/** 创建可安全返回调用方的业务错误 */
	constructor(
		// 可返回调用方的稳定业务错误码。
		readonly code: string,

		message: string,

		// 调用方是否可以使用相同操作重试。
		readonly retryable = false,
	) {
		// 保留标准错误消息和堆栈，业务分类由错误码与重试标志表达。
		super(message);
	}
}
