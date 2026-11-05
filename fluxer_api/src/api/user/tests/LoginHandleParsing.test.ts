// SPDX-License-Identifier: AGPL-3.0-or-later

import {parseLoginHandle} from '@app/api/user/UniqueUsernames';
import {describe, expect, it} from 'vitest';

describe('parseLoginHandle', () => {
	it.each(['discord.name', 'Discord.Name_123', 'a', `${'a'.repeat(31)}.`])(
		'accepts username %s unchanged',
		(username) => {
			expect(parseLoginHandle(` ${username} `)).toEqual({username, discriminator: null});
		},
	);
	it.each(['1', '0001', '9999'])('accepts a dotted legacy tag with discriminator %s', (discriminator) => {
		expect(parseLoginHandle(`Discord.Name#${discriminator}`)).toEqual({
			username: 'Discord.Name',
			discriminator: Number.parseInt(discriminator, 10),
		});
	});
	it.each(['', `${'a'.repeat(32)}.`, 'name-name', 'name name', 'name@example.com', 'name#', 'name#12345'])(
		'rejects invalid handle %s',
		(handle) => {
			expect(parseLoginHandle(handle)).toBeNull();
		},
	);
});
