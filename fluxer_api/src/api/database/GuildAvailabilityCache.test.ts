// SPDX-License-Identifier: AGPL-3.0-or-later

import {createGuildID} from '@app/api/BrandedTypes';
import {type GuildAvailability, GuildAvailabilityCache} from '@app/api/database/GuildAvailabilityCache';
import {describe, expect, it, vi} from 'vitest';

const id = createGuildID(1n);
const available: GuildAvailability = {guildId: id, unavailableForEveryone: false, unavailableForNonStaff: false};

describe('GuildAvailabilityCache', () => {
	it('coalesces reads, freezes minimal snapshots and expires from query start', async () => {
		let now = 0;
		const load = vi.fn(async () => available);
		const cache = new GuildAvailabilityCache(load, {now: () => now});
		cache.setReady(true);
		const values = await Promise.all([cache.get(id), cache.get(id)]);
		expect(load).toHaveBeenCalledTimes(1);
		expect(values[0]).toBe(values[1]);
		expect(Object.isFrozen(values[0])).toBe(true);
		await cache.get(id);
		expect(load).toHaveBeenCalledTimes(1);
		now = 1000;
		await cache.get(id);
		expect(load).toHaveBeenCalledTimes(2);
	});

	it('does not cache missing guilds or errors', async () => {
		const load = vi
			.fn<() => Promise<GuildAvailability | null>>()
			.mockResolvedValueOnce(null)
			.mockRejectedValueOnce(new Error('database down'))
			.mockResolvedValue(available);
		const cache = new GuildAvailabilityCache(load);
		cache.setReady(true);
		expect(await cache.get(id)).toBeNull();
		await expect(cache.get(id)).rejects.toThrow('database down');
		expect(await cache.get(id)).toEqual(available);
		expect(load).toHaveBeenCalledTimes(3);
	});

	it.each(['invalidate', 'disconnect', 'clear'] as const)('suppresses an old read refill after %s', async (action) => {
		const old = Promise.withResolvers<GuildAvailability | null>();
		const disabled = {...available, unavailableForEveryone: true};
		const load = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(disabled);
		const cache = new GuildAvailabilityCache(load);
		cache.setReady(true);
		const first = cache.get(id);
		await Promise.resolve();
		if (action === 'invalidate') cache.invalidate(id);
		else if (action === 'clear') cache.clear();
		else {
			cache.setReady(false);
			cache.setReady(true);
		}
		expect(await cache.get(id)).toEqual(disabled);
		old.resolve(available);
		expect(await first).toEqual(available); // Already-running request retains its database snapshot.
		expect(await cache.get(id)).toEqual(disabled);
		expect(load).toHaveBeenCalledTimes(2);
	});

	it('bypasses when disconnected and clears state on recovery', async () => {
		const load = vi.fn(async () => available);
		const cache = new GuildAvailabilityCache(load);
		cache.setReady(true);
		await cache.get(id);
		cache.setReady(false);
		await Promise.all([cache.get(id), cache.get(id)]);
		expect(load).toHaveBeenCalledTimes(3);
		cache.setReady(true);
		await cache.get(id);
		expect(load).toHaveBeenCalledTimes(4);
	});

	it('bounds entries and flights, including invalidated flights still running', async () => {
		const first = Promise.withResolvers<GuildAvailability | null>();
		const load = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(available);
		const cache = new GuildAvailabilityCache(load, {capacity: 1, maxFlights: 1});
		cache.setReady(true);
		const pending = cache.get(id);
		await Promise.resolve();
		cache.invalidate(id);
		await cache.get(id);
		expect(cache.renderMetrics()).toContain('fluxer_guild_availability_bypassed_total 1');
		first.resolve(available);
		await pending;
		await cache.get(id);
		await cache.get(createGuildID(2n));
		expect(cache.renderMetrics()).toContain('fluxer_guild_availability_entries 1');
		await cache.get(id);
		expect(load).toHaveBeenCalledTimes(5);
	});

	it('does not cache a slow query past the freshness bound', async () => {
		let now = 0;
		const load = vi.fn(async () => {
			now += 1001;
			return available;
		});
		const cache = new GuildAvailabilityCache(load, {now: () => now});
		cache.setReady(true);
		await cache.get(id);
		await cache.get(id);
		expect(load).toHaveBeenCalledTimes(2);
		expect(cache.renderMetrics()).toContain('fluxer_guild_availability_entries 0');
	});
	it('does not let new requests join a flight older than the freshness bound', async () => {
		let now = 0;
		const old = Promise.withResolvers<GuildAvailability | null>();
		const disabled = {...available, unavailableForEveryone: true};
		const load = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(disabled);
		const cache = new GuildAvailabilityCache(load, {now: () => now});
		cache.setReady(true);
		const pending = cache.get(id);
		await Promise.resolve();
		now = 1000;
		expect(await cache.get(id)).toEqual(disabled);
		old.resolve(available);
		await pending;
		expect(await cache.get(id)).toEqual(disabled);
		expect(load).toHaveBeenCalledTimes(2);
	});
});
