// SPDX-License-Identifier: AGPL-3.0-or-later

import type {UserID} from '@app/api/BrandedTypes';
import type {User} from '@app/api/models/User';
import type {HonoEnv} from '@app/api/types/HonoEnv';
import {stripApiPrefix} from '@app/api/utils/RequestPathUtils';
import type {Context} from 'hono';

/** 已读请求的窄认证身份，不构造或冒充完整 User 模型。 */
export interface ReadStatePrincipal {
	/** 已认证用户标识。 */
	id: UserID;

	/** 保留普通用户限定和机器人判断。 */
	isBot: boolean;

	/** 保留封禁、工作人员和限流标志。 */
	flags: bigint;

	/** 保留删除状态的实时检查。 */
	deletionStartedAt: Date | null;

	/** 保留临时封禁的实时检查。 */
	tempBannedUntil: Date | null;

	/** 保留错误响应语言选择。 */
	locale: string | null;
}

/** 只允许三个既有 POST 已读接口进入窄认证，其他方法和相似路径沿用完整用户。 */
export function isReadStatePrincipalRequest(method: string, path: string): boolean {
	if (method !== 'POST') return false;
	const normalized = stripApiPrefix(path);
	return (
		normalized === '/read-states/ack' ||
		normalized === '/read-states/ack-bulk' ||
		/^\/channels\/[1-9]\d{0,19}\/messages\/[1-9]\d{0,19}\/ack$/.test(normalized)
	);
}

/** 公共中间件仅消费身份字段，完整用户模型仍保留独立上下文。 */
export function getRequestIdentity(ctx: Context<HonoEnv>): User | ReadStatePrincipal | undefined {
	return ctx.get('user') ?? ctx.get('readStatePrincipal');
}
