// SPDX-License-Identifier: AGPL-3.0-or-later

import {createChannelID, createGuildID} from '@app/api/BrandedTypes';
import {type ChannelMetadata, ChannelMetadataCache} from '@app/api/database/ChannelMetadataCache';
import {describe, expect, it, vi} from 'vitest';

/** 创建只包含稳定字段的测试元数据 */
function metadata(id = 1, type = 1): ChannelMetadata {
	return {channelId: createChannelID(BigInt(id)), guildId: createGuildID(9n), type};
}

describe('shared channel metadata cache', () => {
	it('uses LRU and fixed five minute expiry without sliding on hits', async () => {
		let now = 0;
		const load = vi.fn(
			async (ids: Array<ReturnType<typeof createChannelID>>) => new Map(ids.map((id) => [id, metadata(Number(id))])),
		);
		const cache = new ChannelMetadataCache(load, {capacity: 2, now: () => now});
		cache.setReady(true);
		const [a, b, c] = [1n, 2n, 3n].map(createChannelID);
		await cache.getMany([a!, b!]);
		now = 299_999;
		await cache.get(a!);
		await cache.get(c!);
		await cache.get(a!);
		expect(load).toHaveBeenCalledTimes(2);
		await cache.get(b!);
		expect(load).toHaveBeenCalledTimes(3);
		now = 300_000;
		await cache.get(a!);
		expect(load).toHaveBeenCalledTimes(4);
	});

	it('coalesces misses, returns immutable data and does not cache absent rows or errors', async () => {
		const id = createChannelID(1n);
		const flight = Promise.withResolvers<Map<typeof id, ChannelMetadata>>();
		const load = vi
			.fn()
			.mockReturnValueOnce(flight.promise)
			.mockResolvedValueOnce(new Map())
			.mockRejectedValueOnce(new Error('db unavailable'))
			.mockResolvedValue(new Map([[id, metadata()]]));
		const cache = new ChannelMetadataCache(load);
		cache.setReady(true);
		const first = cache.get(id);
		const second = cache.get(id);
		flight.resolve(new Map([[id, metadata()]]));
		expect(await first).toBe(await second);
		expect(Object.isFrozen(await cache.get(id))).toBe(true);
		expect(load).toHaveBeenCalledTimes(1);
		cache.invalidate(id);
		expect(await cache.get(id)).toBeNull();
		await expect(cache.get(id)).rejects.toThrow('db unavailable');
		expect(await cache.get(id)).toEqual(metadata());
		expect(load).toHaveBeenCalledTimes(4);
	});

	it.each(['invalidate', 'reconnect'] as const)(
		'prevents stale refills after %s and lets new callers start fresh',
		async (kind) => {
			const id = createChannelID(1n);
			const old = Promise.withResolvers<Map<typeof id, ChannelMetadata>>();
			const load = vi
				.fn()
				.mockReturnValueOnce(old.promise)
				.mockResolvedValue(new Map([[id, metadata(1, 2)]]));
			const cache = new ChannelMetadataCache(load);
			cache.setReady(true);
			const pending = cache.get(id);
			if (kind === 'invalidate') cache.invalidate(id);
			else {
				cache.setReady(false);
				cache.setReady(true);
			}
			expect(await cache.get(id)).toEqual(metadata(1, 2));
			old.resolve(new Map([[id, metadata(1, 1)]]));
			expect(await pending).toEqual(metadata(1, 1));
			expect(await cache.get(id)).toEqual(metadata(1, 2));
			expect(load).toHaveBeenCalledTimes(2);
		},
	);

	it('chunks cold batches into at most one hundred IDs and bounds active fills', async () => {
		const pending = Promise.withResolvers<Map<ReturnType<typeof createChannelID>, ChannelMetadata>>();
		const load = vi.fn().mockReturnValue(pending.promise);
		const cache = new ChannelMetadataCache(load, {maxFlights: 1024});
		cache.setReady(true);
		const ids = Array.from({length: 1200}, (_, i) => createChannelID(BigInt(i + 1)));
		const waiting = cache.getMany(ids);
		expect(load.mock.calls.every(([batch]) => batch.length <= 100)).toBe(true);
		expect(cache.renderMetrics()).toContain('fills_inflight 1024');
		expect(cache.renderMetrics()).toContain('bypassed_total 176');
		pending.resolve(new Map());
		await waiting;
		expect(cache.renderMetrics()).toContain('fills_inflight 0');
	});

	it('bypasses while the listener is unavailable and starts with an empty cache on recovery', async () => {
		const id = createChannelID(1n);
		const load = vi.fn(async () => new Map([[id, metadata()]]));
		const cache = new ChannelMetadataCache(load);
		await cache.get(id);
		await cache.get(id);
		expect(load).toHaveBeenCalledTimes(2);
		cache.setReady(true);
		await cache.get(id);
		await cache.get(id);
		expect(load).toHaveBeenCalledTimes(3);
		cache.setReady(false);
		await cache.get(id);
		expect(load).toHaveBeenCalledTimes(4);
	});
});
