// SPDX-License-Identifier: AGPL-3.0-or-later

/** Reuse the explicit integration target. No global/single-community inference. */
export function forumNsfwGuildId(): string | null {
	const value = process.env.INTEGRATION_GUILD_ID;
	return typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n
		? value
		: null;
}
