// SPDX-License-Identifier: AGPL-3.0-or-later

import {createChannelID, createGuildID} from '@app/api/BrandedTypes';
import type {ChannelRepository} from '@app/api/channel/ChannelRepository';
import {loadThreadViews} from '@app/api/channel/services/thread/ThreadViews';
import {setCassandraQueryExecutorForTesting} from '@app/api/database/CassandraQueryExecution';
import type {Channel} from '@app/api/models/Channel';
import type {ThreadState} from '@app/api/models/ThreadState';
import {afterEach, expect, it, vi} from 'vitest';

afterEach(() => {
	setCassandraQueryExecutorForTesting(null);
});

it.each([true, false])('keeps full post reads and batches only missing parent metadata, shared=%s', async (shared) => {
	const parent = createChannelID(1n);
	const thread = createChannelID(2n);
	const guildId = createGuildID(3n);
	const metadata = vi.fn(async () => new Map([[parent, {channelId: parent, guildId, type: 15}]]));
	setCassandraQueryExecutorForTesting({
		executeQuery: async () => [],
		executeBatch: async () => {},
		...(shared ? {getChannelMetadata: metadata} : {}),
	});
	const listChannels = vi.fn(async (ids: Array<typeof parent>) =>
		ids.map((id) => ({id, type: id === parent ? 15 : 11}) as Channel),
	);
	const repository = {
		channelData: {listChannels},
		threads: {getStatsMany: async () => new Map()},
	} as unknown as ChannelRepository;
	const state = {threadId: thread, parentId: parent, guildId, appliedTags: []} as unknown as ThreadState;
	const views = await loadThreadViews(repository, [state]);
	expect(views[0]?.channel.id).toBe(thread);
	expect(views[0]?.parentType).toBe(15);
	expect(listChannels).toHaveBeenCalledWith([thread]);
	if (shared) {
		expect(metadata).toHaveBeenCalledWith([parent]);
		expect(listChannels).toHaveBeenCalledTimes(1);
	} else {
		expect(metadata).not.toHaveBeenCalled();
		expect(listChannels).toHaveBeenCalledWith([parent]);
	}
	listChannels.mockClear();
	metadata.mockClear();
	await loadThreadViews(repository, [state], [{id: parent, type: 15} as Channel]);
	expect(listChannels).toHaveBeenCalledTimes(1);
	expect(metadata).not.toHaveBeenCalled();
});
