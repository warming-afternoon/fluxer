// SPDX-License-Identifier: AGPL-3.0-or-later

import {beforeEach, describe, expect, it, vi} from 'vitest';

const {runtimeConfig, getUserByTag} = vi.hoisted(() => ({
	runtimeConfig: {usesUniqueUsernames: true},
	getUserByTag: vi.fn(),
}));
vi.mock('../src/features/app/state/RuntimeConfig', () => ({default: runtimeConfig}));
vi.mock('../src/features/channel/state/Channels', () => ({default: {}}));
vi.mock('../src/features/user/state/Users', () => ({default: {getUserByTag}}));

import {parseQuery} from '../src/features/search/utils/SearchQueryParser';

describe('search username parsing', () => {
	beforeEach(() => {
		runtimeConfig.usesUniqueUsernames = true;
		getUserByTag.mockReset().mockReturnValue({id: '123456789012345678'});
	});
	it.each([
		['from', 'authorId'],
		['-from', 'excludeAuthorId'],
		['mentions', 'mentions'],
		['-mentions', 'excludeMentions'],
	])('resolves dotted usernames in %s filters', (filter, field) => {
		expect(parseQuery(`${filter}:Discord.Name_123`)).toEqual({[field]: ['123456789012345678']});
		expect(getUserByTag).toHaveBeenCalledWith('Discord.Name_123');
	});
	it('resolves dotted legacy tags when unique usernames are disabled', () => {
		runtimeConfig.usesUniqueUsernames = false;
		expect(parseQuery('from:Discord.Name#1234')).toEqual({authorId: ['123456789012345678']});
		expect(getUserByTag).toHaveBeenCalledWith('Discord.Name#1234');
	});
	it('still rejects bare usernames when unique usernames are disabled', () => {
		runtimeConfig.usesUniqueUsernames = false;
		expect(parseQuery('from:Discord.Name')).toEqual({});
		expect(getUserByTag).not.toHaveBeenCalled();
	});
	it.each(['name-name', 'name@name'])('still rejects unsupported username %s', (username) => {
		expect(parseQuery(`from:${username}`)).toEqual({});
		expect(getUserByTag).not.toHaveBeenCalled();
	});
});
