// SPDX-License-Identifier: AGPL-3.0-or-later

import {createGuildID, createUserID} from '@app/api/BrandedTypes';
import {syncForumNsfwPreference} from '@app/integration/ForumNsfwPreferenceClient';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';

vi.hoisted(() => {
	vi.resetModules();
});
const state = vi.hoisted(() => ({request: vi.fn(), connection: vi.fn()}));
vi.mock('@app/integration/IntegrationNatsConnection', () => ({getIntegrationNatsConnection: state.connection}));
const user = createUserID(10n),
	guild = createGuildID(20n);
const ack = {ok: true, data: {user_id: '10', guild_id: '20', show_nsfw: false, nsfw_version: 2}};
function response(value: unknown) {
	const text = JSON.stringify(value);
	return {data: Buffer.from(text), string: () => text};
}
beforeEach(() => {
	vi.stubEnv('INTEGRATION_GUILD_ID', '20');
	state.request.mockReset().mockResolvedValue(response(ack));
	state.connection.mockReset().mockResolvedValue({request: state.request});
});
afterEach(() => vi.unstubAllEnvs());

it('sends only the versioned minimal apply payload with a bounded timeout', async () => {
	await syncForumNsfwPreference(user, guild, false, 2);
	const [subject, payload, options] = state.request.mock.calls[0]!;
	expect(subject).toBe('rpc.forum.v1.nsfw.apply');
	expect(JSON.parse(payload)).toEqual({version: 1, request_id: expect.any(String), ...ack.data});
	expect(JSON.parse(payload).request_id).toMatch(/^[a-f0-9-]{36}$/);
	expect(options).toEqual({timeout: 8000});
});

it.each([
	{...ack, data: {...ack.data, user_id: '11'}},
	{...ack, data: {...ack.data, guild_id: '21'}},
	{...ack, data: {...ack.data, show_nsfw: true}},
	{...ack, data: {...ack.data, nsfw_version: 1}},
	{...ack, data: {...ack.data, nsfw_version: 3}},
	{...ack, data: {...ack.data, nsfw_version: '2'}},
	{ok: false, error: {code: 'INVALID_REQUEST', message: 'private remote detail'}},
	null,
	true,
	{ok: true},
])('rejects uncorrelated, superseded or unsuccessful acknowledgments %#', async (value) => {
	state.request.mockResolvedValue(response(value));
	await expect(syncForumNsfwPreference(user, guild, false, 2)).rejects.toMatchObject({code: 'UNAVAILABLE'});
});

it('maps timeout, malformed JSON and oversized replies to a generic retryable failure', async () => {
	for (const value of [
		{data: Buffer.from('{'), string: () => '{'},
		{data: Buffer.alloc(4097), string: () => JSON.stringify(ack)},
	]) {
		state.request.mockResolvedValueOnce(value);
		await expect(syncForumNsfwPreference(user, guild, false, 2)).rejects.toMatchObject({
			code: 'UNAVAILABLE',
			retryable: true,
		});
	}
	state.request.mockRejectedValueOnce(new Error('secret connection details'));
	await expect(syncForumNsfwPreference(user, guild, false, 2)).rejects.toThrow(
		'Forum preference synchronization is unconfirmed',
	);
});

it('rejects missing scope, another guild and invalid versions before connecting', async () => {
	await expect(syncForumNsfwPreference(user, createGuildID(21n), false, 2)).rejects.toMatchObject({
		code: 'RESOURCE_NOT_ALLOWED',
	});
	for (const version of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
		await expect(syncForumNsfwPreference(user, guild, false, version)).rejects.toMatchObject({code: 'INVALID_REQUEST'});
	vi.stubEnv('INTEGRATION_GUILD_ID', '');
	await expect(syncForumNsfwPreference(user, guild, false, 2)).rejects.toMatchObject({code: 'RESOURCE_NOT_ALLOWED'});
	expect(state.connection).not.toHaveBeenCalled();
});

it('bounds inflight requests and releases slots after failed attempts', async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	state.request.mockImplementation(async () => {
		await gate;
		return response(ack);
	});
	const requests = Array.from({length: 32}, () => syncForumNsfwPreference(user, guild, false, 2));
	await expect(syncForumNsfwPreference(user, guild, false, 2)).rejects.toMatchObject({code: 'UNAVAILABLE'});
	release();
	await Promise.all(requests);
	await syncForumNsfwPreference(user, guild, false, 2);
});
