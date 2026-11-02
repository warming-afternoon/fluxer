// SPDX-License-Identifier: AGPL-3.0-or-later

/** JSON-facing versions stay exact safe integers; Cassandra bigint parameters use native bigint. */
export function readSafeIntegerVersion(value: unknown, minimum: 0 | 1 = 1): number {
	if (typeof value === 'bigint') {
		if (value < BigInt(minimum) || value > BigInt(Number.MAX_SAFE_INTEGER))
			throw new RangeError('Invalid Cassandra version');
		return Number(value);
	}
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum)
		throw new RangeError('Invalid Cassandra version');
	return value;
}
