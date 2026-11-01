// SPDX-License-Identifier: AGPL-3.0-or-later

import {createChannelID, createUserID} from '@app/api/BrandedTypes';
import {
	type CassandraQueryExecutorForTesting,
	setCassandraQueryExecutorForTesting,
} from '@app/api/database/CassandraQueryExecution';
import {
	clearReadStateChannelMetaCacheForTesting,
	resolveReadStateMarker,
} from '@app/api/read_state/ReadStateChannelMeta';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';

beforeEach(() => {
	clearReadStateChannelMetaCacheForTesting();
});
afterEach(() => {
	setCassandraQueryExecutorForTesting(null);
});

it('keeps the legacy cache for Cassandra without requiring notification support', async () => {
	const executeQuery = vi.fn(async () => [{channel_id: 1n, guild_id: null, type: 1}]);
	setCassandraQueryExecutorForTesting({executeQuery, executeBatch: async () => {}} as CassandraQueryExecutorForTesting);
	const request = {userId: createUserID(2n), channelId: createChannelID(1n), capable: true};
	await resolveReadStateMarker(request);
	await resolveReadStateMarker(request);
	expect(executeQuery).toHaveBeenCalledTimes(1);
});

it('uses only the shared lookup for PostgreSQL, including when a channel does not exist', async () => {
	const executeQuery = vi.fn(async () => []);
	const getChannelMetadata = vi.fn(async () => new Map());
	setCassandraQueryExecutorForTesting({executeQuery, executeBatch: async () => {}, getChannelMetadata});
	const request = {userId: createUserID(2n), channelId: createChannelID(1n), capable: true};
	await resolveReadStateMarker(request);
	await resolveReadStateMarker(request);
	expect(getChannelMetadata).toHaveBeenCalledTimes(2);
	expect(executeQuery).not.toHaveBeenCalled();
});
