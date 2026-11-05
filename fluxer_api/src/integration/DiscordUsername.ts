// SPDX-License-Identifier: AGPL-3.0-or-later

import type {UserID} from '@app/api/BrandedTypes';
import {UsernameType} from '@fluxer/schema/src/primitives/UserValidators';

// 原生用户名允许的最大长度。
const MAX_USERNAME_LENGTH = 32;

/** 保留合法 Discord 用户名；仅对原生不接受的字符、长度或保留字做降级。 */
export function discordUsernameBase(username: string): string {
	// 优先保留原始用户名，避免修改已兼容的 Discord 身份。
	const exact = UsernameType.safeParse(username);
	if (exact.success) return exact.data;
	// 仅在原值不合法时清理字符并截断，仍不合法则使用固定基础名。
	const normalized = UsernameType.safeParse(username.replace(/[^a-zA-Z0-9_.]/g, '').slice(0, MAX_USERNAME_LENGTH));
	return normalized.success ? normalized.data : 'discord';
}

/** 只有确认重名后才使用稳定后缀，重试不生成新的随机用户名。 */
export function discordUsernameCandidate(base: string, userId: UserID, attempt: number): string {
	// 首次尝试不加后缀，冲突后以用户标识生成可重复的候选名。
	if (attempt === 0) return base;
	const suffix = `_${userId}${attempt === 1 ? '' : `_${attempt}`}`;
	return UsernameType.parse(`${base.slice(0, MAX_USERNAME_LENGTH - suffix.length)}${suffix}`);
}
