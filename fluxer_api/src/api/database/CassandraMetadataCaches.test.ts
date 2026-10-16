// SPDX-License-Identifier: AGPL-3.0-or-later

import {createChannelID, createGuildID} from '@app/api/BrandedTypes';
import {CassandraMetadataCaches} from '@app/api/database/CassandraMetadataCaches';
import type {MetadataNotificationConnections} from '@app/api/database/CassandraMetadataInvalidation';
import type {PreparedQuery} from '@app/api/database/CassandraTypes';
import {afterEach, describe, expect, it, vi} from 'vitest';

vi.mock('@app/api/Config', () => ({Config: {nodeEnv: 'test'}}));
vi.mock('@app/api/Logger', () => ({Logger: {warn: vi.fn()}}));

const active: Array<CassandraMetadataCaches> = [];
afterEach(async () => {
	await Promise.all(active.splice(0).map((cache) => cache.shutdown()));
	vi.useRealTimers();
});

/** 两个独立缓存共享数据库模拟和有意可丢失的广播。 */
function setup() {
	const subscribers: Array<{channel: string; receive: (value: string) => void}> = [];
	let drop = false;
	const rows = new Map(
		[1n, 2n].map((id) => [id, {channel_id: createChannelID(id), guild_id: createGuildID(9n), type: 0}]),
	);
	const load = vi.fn(async (query: PreparedQuery) =>
		query.kvMeta!.table.name === 'channels'
			? (query.params.channel_ids as Array<bigint>).map((id) => rows.get(id)).filter(Boolean)
			: [{guild_id: createGuildID(9n), features: new Set<string>()}],
	);
	const publish = vi.fn(async (channel: string, value: string) => {
		if (!drop) for (const sub of subscribers) if (sub.channel === channel) sub.receive(value);
	});
	const make = (channelEnabled = true, guildEnabled = true) => {
		const connections: MetadataNotificationConnections = {
			publish,
			connect: async (channel, receive, state) => {
				subscribers.push({channel, receive});
				state(true);
			},
			close() {},
		};
		const cache = new CassandraMetadataCaches(load as never, {channelEnabled, guildEnabled}, 'test', {
			namespace: 'deployment',
			kv: {url: 'redis://127.0.0.1'},
			connections,
		});
		active.push(cache);
		cache.start();
		return cache;
	};
	return {
		load,
		rows,
		publish,
		make,
		drop: () => {
			drop = true;
		},
	};
}

describe('Cassandra local metadata caches', () => {
	it('invalidates one channel across instances without evicting other channels or guilds', async () => {
		const {make, load, rows} = setup();
		const first = make(),
			second = make();
		const ids = [1n, 2n].map(createChannelID);
		for (const cache of [first, second]) {
			await cache.getChannelMetadata(ids);
			await cache.getGuildAvailability(createGuildID(9n));
		}
		await first.mutate(async () => {
			rows.get(1n)!.type = 11;
		}, [{entity: 'channel', ids: ['1']}]);
		await vi.waitFor(async () => expect((await second.getChannelMetadata([ids[0]!]))!.get(ids[0]!)!.type).toBe(11));
		const count = load.mock.calls.length;
		await second.getChannelMetadata([ids[1]!]);
		await second.getGuildAvailability(createGuildID(9n));
		expect(load).toHaveBeenCalledTimes(count);
	});

	it('invalidates a guild without evicting channels and keeps disabled paths absent', async () => {
		const {make, load} = setup();
		const cache = make();
		await cache.getChannelMetadata([createChannelID(1n)]);
		await cache.getGuildAvailability(createGuildID(9n));
		await cache.mutate(async () => {}, [{entity: 'guild', ids: ['9']}]);
		const count = load.mock.calls.length;
		await cache.getChannelMetadata([createChannelID(1n)]);
		expect(load).toHaveBeenCalledTimes(count);
		await cache.getGuildAvailability(createGuildID(9n));
		expect(load).toHaveBeenCalledTimes(count + 1);
		const disabled = make(false, false);
		expect(disabled.getChannelMetadata([createChannelID(1n)])).toBeNull();
		expect(disabled.getGuildAvailability(createGuildID(9n))).toBeNull();
	});

	it('preserves database success and original errors when notification publication fails', async () => {
		const {make, publish} = setup();
		publish.mockRejectedValue(new Error('offline'));
		const cache = make();
		await expect(cache.mutate(async () => 42, [{entity: 'channel', ids: ['1']}])).resolves.toBe(42);
		const original = new Error('uncertain database outcome');
		await expect(
			cache.mutate(async () => {
				throw original;
			}, [{entity: 'channel', ids: ['1']}]),
		).rejects.toBe(original);
		await vi.waitFor(() => expect(cache.renderMetrics()).toMatch(/notifications_failures_total [1-9]/));
		await cache.getChannelMetadata([createChannelID(1n)]);
		expect(cache.renderMetrics()).toContain('fluxer_channel_metadata_ready 1');
	});

	it('converges by fixed TTL after a deliberately dropped remote notification', async () => {
		vi.useFakeTimers({toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout']});
		const {make, rows, drop, load} = setup();
		const first = make(),
			second = make();
		const id = createChannelID(1n);
		await second.getChannelMetadata([id]);
		await second.getGuildAvailability(createGuildID(9n));
		drop();
		await first.mutate(async () => {
			rows.get(1n)!.type = 11;
		}, [{entity: 'channel', ids: ['1']}]);
		expect((await second.getChannelMetadata([id]))!.get(id)!.type).toBe(0);
		const count = load.mock.calls.length;
		await vi.advanceTimersByTimeAsync(1000);
		await second.getGuildAvailability(createGuildID(9n));
		expect(load).toHaveBeenCalledTimes(count + 1);
		await vi.advanceTimersByTimeAsync(299_000);
		expect((await second.getChannelMetadata([id]))!.get(id)!.type).toBe(11);
	});
});
