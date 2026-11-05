// SPDX-License-Identifier: AGPL-3.0-or-later

/** 将持久版本校验为精确安全整数，供 JSON 返回和 Cassandra 参数转换。 */
export function readSafeIntegerVersion(value: unknown, minimum: 0 | 1 = 1): number {
	// 显式限制精度与最小值，避免持久版本经 JSON 转换后发生截断。
	if (typeof value === 'bigint') {
		if (value < BigInt(minimum) || value > BigInt(Number.MAX_SAFE_INTEGER))
			throw new RangeError('Invalid Cassandra version');
		return Number(value);
	}
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum)
		throw new RangeError('Invalid Cassandra version');
	return value;
}
