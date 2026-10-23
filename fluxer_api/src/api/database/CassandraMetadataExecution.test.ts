// SPDX-License-Identifier: AGPL-3.0-or-later

import {createChannelID} from '@app/api/BrandedTypes';
import {
	BatchBuilder,
	executeConditional,
	executeQuery,
	fetchPage,
	setCassandraQueryExecutorForTesting,
	setDatabaseQueryExecutor,
	shutdownDatabaseQueryExecutor,
	startCassandraMetadataCaches,
} from '@app/api/database/CassandraQueryExecution';
import {Db} from '@app/api/database/CassandraTypes';
import {Channels} from '@app/api/Tables';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';

vi.hoisted(() => vi.resetModules());
const mocks = vi.hoisted(() => ({execute: vi.fn(), batch: vi.fn(), publish: vi.fn()}));
vi.mock('@pkgs/cassandra/src/Client', async (original) => ({
	...(await original<object>()),
	getClient: () => ({execute: mocks.execute, batch: mocks.batch}),
}));
vi.mock('@app/api/Config', () => ({Config: {nodeEnv: 'production'}}));
vi.mock('@app/api/Logger', () => ({Logger: {warn: vi.fn()}}));

beforeEach(async () => {
	setCassandraQueryExecutorForTesting(null);
	setDatabaseQueryExecutor(null);
	mocks.execute.mockReset().mockResolvedValue({rows: []});
	mocks.batch.mockReset().mockResolvedValue({rows: []});
	mocks.publish.mockReset().mockResolvedValue(undefined);
	await startCassandraMetadataCaches({channelEnabled: true, guildEnabled: true}, 'test', {
		namespace: 'test',
		kv: {url: 'redis://127.0.0.1'},
		connections: {
			publish: mocks.publish,
			connect: async () => {
				throw new Error('offline');
			},
			close() {},
		},
	});
});
afterEach(shutdownDatabaseQueryExecutor);

const update = () => Channels.patchByPk({channel_id: createChannelID(1n), soft_deleted: false}, {type: Db.set(11)});

it('does not require a healthy subscriber or publisher before writing', async () => {
	mocks.publish.mockRejectedValue(new Error('offline'));
	await expect(executeQuery(update())).resolves.toEqual([]);
	expect(mocks.execute).toHaveBeenCalledTimes(1);
	await vi.waitFor(() => expect(mocks.publish).toHaveBeenCalledTimes(1));
	expect(JSON.parse(mocks.publish.mock.calls[0]![1])).toMatchObject({entity: 'channel', ids: ['1']});
});

it('preserves uncertain driver failures and still attempts invalidation', async () => {
	const original = new Error('database write timeout');
	mocks.execute.mockRejectedValue(original);
	await expect(executeQuery(update())).rejects.toBe(original);
	await vi.waitFor(() => expect(mocks.publish).toHaveBeenCalledTimes(1));
	expect(mocks.execute).toHaveBeenCalledTimes(1);
});

it('invalidates each completed or uncertain chunk without retrying writes', async () => {
	mocks.batch.mockResolvedValueOnce({rows: []}).mockRejectedValueOnce(new Error('unknown second chunk'));
	await expect(new BatchBuilder().addPrepared(update()).addPrepared(update()).executeChunked(1)).rejects.toThrow(
		'unknown second chunk',
	);
	expect(mocks.batch).toHaveBeenCalledTimes(2);
	await vi.waitFor(() => expect(mocks.publish.mock.calls.length).toBeGreaterThan(0));
});

it('does not publish a definitely unapplied conditional result', async () => {
	mocks.execute.mockResolvedValueOnce({rows: [{'[applied]': false}]});
	const conditional = Channels.conditionalPatchByPk(
		{channel_id: createChannelID(1n), soft_deleted: false},
		{type: Db.set(11)},
		{type: 0},
	);
	await expect(executeConditional(conditional)).resolves.toBe(false);
	await Promise.resolve();
	expect(mocks.publish).not.toHaveBeenCalled();
});

it('keeps reads and unrelated writes out of notification traffic and rejects paged writes', async () => {
	await executeQuery('SELECT type FROM channels WHERE channel_id=:channel_id', {channel_id: 1n});
	await executeQuery('UPDATE read_states SET message_id=:message_id WHERE user_id=:user_id', {
		message_id: 3n,
		user_id: 2n,
	});
	expect(mocks.publish).not.toHaveBeenCalled();
	await expect(fetchPage(update(), undefined, {pageSize: 1})).rejects.toThrow('requires a SELECT');
	expect(mocks.execute).toHaveBeenCalledTimes(2);
});
