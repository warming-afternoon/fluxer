// SPDX-License-Identifier: AGPL-3.0-or-later

import type {GatewayHandlerContext} from '@app/features/gateway/events/EventRouter';
import GatewaySessions from '@app/features/gateway/transport/GatewaySessionPool';
import ThreadWatches, {type ThreadWatchAck} from '@app/features/threads/state/ThreadWatches';

/** 只让前台账号连接的确认改变当前页面浏览状态 */
export function handleThreadWatchAck(data: ThreadWatchAck, context: GatewayHandlerContext): void {
	// 账号后台连接或已经替换的套接字不能确认当前订阅
	if (context.socket !== GatewaySessions.foregroundConnection.socket) return;
	ThreadWatches.handleAck(data);
}
