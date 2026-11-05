// SPDX-License-Identifier: AGPL-3.0-or-later

/** 只使用明确配置的集成目标，不推断全局或单社区范围。 */
export function forumNsfwGuildId(): string | null {
	// 仅接受 Cassandra 有符号长整数范围内的正整数标识。
	const value = process.env.INTEGRATION_GUILD_ID;
	return typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n
		? value
		: null;
}
