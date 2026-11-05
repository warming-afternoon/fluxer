// SPDX-License-Identifier: AGPL-3.0-or-later

import {createChannelID, createGuildID, createUserID} from '@app/api/BrandedTypes';
import type {ChannelRepository} from '@app/api/channel/ChannelRepository';
import {NsfwVisibility} from '@app/api/channel/utils/NsfwVisibility';
import type {GuildRepository} from '@app/api/guild/repositories/GuildRepository';
import type {ReadState} from '@app/api/models/ReadState';
import {filterNsfwReadStates} from '@app/api/read_state/ReadStateVisibility';
import {afterEach, expect, it, vi} from 'vitest';

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});
function state(id: number, guild: number | null): ReadState {
	return {
		channelId: createChannelID(BigInt(id)),
		guildId: guild === null ? null : createGuildID(BigInt(guild)),
	} as ReadState;
}
function repository(channels: Array<{id: bigint; hidden?: boolean}>) {
	return {channelData: {listChannels: vi.fn(async () => channels)}} as unknown as ChannelRepository;
}
it('drops unresolvable legacy and target metadata while retaining known DM and other-guild resources', async () => {
	vi.stubEnv('INTEGRATION_GUILD_ID', '20');
	const states = [
		state(1, null),
		state(2, null),
		state(3, null),
		state(4, 20),
		state(5, 21),
		state(6, 20),
		state(7, 21),
	];
	const channels = [{id: 1n}, {id: 2n}, {id: 4n, hidden: true}, {id: 6n}];
	vi.spyOn(NsfwVisibility.prototype, 'filter').mockImplementation(async (rows) =>
		rows.filter((row) => !(row as unknown as {hidden?: boolean}).hidden),
	);
	const result = await filterNsfwReadStates(states, createUserID(10n), repository(channels), {} as GuildRepository);
	expect(result.map((row) => row.channelId)).toEqual([1n, 2n, 5n, 6n, 7n]);
});
it('reports failed channel authority as unavailable rather than returning metadata or fake success', async () => {
	vi.stubEnv('INTEGRATION_GUILD_ID', '20');
	const repo = repository([]);
	vi.mocked(repo.channelData.listChannels).mockRejectedValue(new Error('offline'));
	await expect(
		filterNsfwReadStates([state(1, null)], createUserID(10n), repo, {} as GuildRepository),
	).rejects.toMatchObject({status: 503});
});
it('leaves existing behavior alone when the integration scope is not configured', async () => {
	vi.stubEnv('INTEGRATION_GUILD_ID', '');
	const states = [state(1, null)];
	const repo = repository([]);
	expect(await filterNsfwReadStates(states, createUserID(10n), repo, {} as GuildRepository)).toBe(states);
	expect(repo.channelData.listChannels).not.toHaveBeenCalled();
});
