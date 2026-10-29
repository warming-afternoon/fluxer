// SPDX-License-Identifier: AGPL-3.0-or-later

export class IntegrationError extends Error {
	/** 创建可安全返回调用方的业务错误 */
	constructor(
		readonly code: string,
		message: string,
		readonly retryable = false,
	) {
		super(message);
	}
}
