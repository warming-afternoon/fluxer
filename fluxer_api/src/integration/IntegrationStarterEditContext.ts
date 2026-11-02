// SPDX-License-Identifier: AGPL-3.0-or-later

import {AsyncLocalStorage} from 'node:async_hooks';

interface IntegrationStarterEditScope {
	/** 已由受信 Forum RPC 验证的实际操作人 */
	actorUserId: string;
	/** 本次受限主帖编辑所属的原生服务器 */
	guildId: string;
	/** 本次受限主帖编辑的原生讨论区 */
	threadId: string;
}

const scopes = new AsyncLocalStorage<Readonly<IntegrationStarterEditScope>>();

/** 仅由服务端受信内容操作建立上下文，浏览器输入和普通 HTTP 不携带此能力。 */
export function withIntegrationStarterEditScope<T>(scope: IntegrationStarterEditScope, execute: () => T): T {
	return scopes.run(Object.freeze({...scope}), execute);
}

/** 原生编辑入口仍需核对实际操作人、资源及部署允许范围。 */
export function currentIntegrationStarterEditScope(): Readonly<IntegrationStarterEditScope> | undefined {
	return scopes.getStore();
}
