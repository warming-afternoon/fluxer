// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID} from '@app/api/BrandedTypes';
import {discordUsernameBase, discordUsernameCandidate} from '@app/integration/DiscordUsername';
import {UsernameType} from '@fluxer/schema/src/primitives/UserValidators';
import {describe, expect, it} from 'vitest';

describe('Discord initial usernames', () => {
	it.each(['discord_name', 'discord.name', 'Mixed.Case', 'a'.repeat(32)])('preserves valid username %s', (name) => {
		expect(discordUsernameBase(name)).toBe(name);
	});

	it.each([
		['discord-name', 'discordname'],
		['a'.repeat(40), 'a'.repeat(32)],
		['☃', 'discord'],
		['everyone', 'discord'],
		['here', 'discord'],
		['FluxerUser', 'discord'],
	])('normalizes only an invalid username %s', (input, expected) => {
		expect(discordUsernameBase(input)).toBe(expected);
		expect(UsernameType.safeParse(expected).success).toBe(true);
	});

	it('uses stable, length-bounded candidates only after a collision', () => {
		const userId = createUserID(123456789012345678n);
		const base = 'a'.repeat(32);
		expect(discordUsernameCandidate(base, userId, 0)).toBe(base);
		expect(discordUsernameCandidate(base, userId, 1)).toBe(`${'a'.repeat(13)}_${userId}`);
		expect(discordUsernameCandidate(base, userId, 2)).toBe(`${'a'.repeat(11)}_${userId}_2`);
		for (let attempt = 0; attempt < 20; attempt++) {
			const candidate = discordUsernameCandidate(base, userId, attempt);
			expect(candidate).toHaveLength(32);
			expect(UsernameType.safeParse(candidate).success).toBe(true);
		}
	});
});
