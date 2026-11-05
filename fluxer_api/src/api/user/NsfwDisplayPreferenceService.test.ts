// SPDX-License-Identifier: AGPL-3.0-or-later
import {createGuildID, createUserID} from '@app/api/BrandedTypes';
import type {IGatewayService} from '@app/api/infrastructure/IGatewayService';
import {UserGuildSettings} from '@app/api/models/UserGuildSettings';
import {NsfwDisplayPreferenceService, reconcileNsfwPreference} from '@app/api/user/NsfwDisplayPreferenceService';
import {
	defaultGuildNsfwSettings,
	type UserGuildNsfwRepository,
} from '@app/api/user/repositories/UserGuildNsfwRepository';
import type {IntegrationEventJournal} from '@app/integration/IntegrationEventJournal';
import {afterEach, expect, it, vi} from 'vitest';

const user = createUserID(10n),
	guild = createGuildID(20n);
afterEach(() => vi.unstubAllEnvs());
function harness() {
	vi.stubEnv('INTEGRATION_GUILD_ID', '20');
	const order: Array<string> = [];
	const track = vi.fn(async () => {
		order.push('track');
	});
	const get = vi.fn(async () => defaultGuildNsfwSettings(user, guild));
	const completePreferenceIntent = vi.fn(async () => {
		order.push('complete');
	});
	const compareAndSet = vi.fn(async () => {
		order.push('cas');
		return new UserGuildSettings({
			...defaultGuildNsfwSettings(user, guild).toRow(),
			show_nsfw: false,
			nsfw_version: 1n,
		});
	});
	const sync = vi.fn(async () => {
		order.push('sync');
	});
	const begin = vi.fn(async () => {
		order.push('begin');
	});
	const gateway = {
		dispatchPresence: vi.fn(async () => {
			order.push('dispatch');
		}),
		syncPushUserGuildSettings: vi.fn(async () => {
			order.push('push');
		}),
	};
	return {
		gateway,
		order,
		track,
		compareAndSet,
		get,
		completePreferenceIntent,
		sync,
		begin,
		service: new NsfwDisplayPreferenceService(
			gateway as unknown as IGatewayService,
			{get, compareAndSet} as unknown as UserGuildNsfwRepository,
			{track, completePreferenceIntent} as unknown as IntegrationEventJournal,
			sync,
			begin,
		),
	};
}
it('writes durable recovery intent before CAS, and confirms synchronous replay fence', async () => {
	const h = harness();
	await h.service.update(user, guild, false, 0);
	expect(h.order).toEqual(['track', 'begin', 'cas', 'sync', 'dispatch', 'push', 'complete']);
	expect(h.track).toHaveBeenCalledWith(expect.stringMatching(/^nsfw:20:10:/), {
		nsfw_preference: true,
		user_id: '10',
		guild_id: '20',
		expected_version: 0,
		show_nsfw: false,
	});
});
it('journal failure starts no native mutation', async () => {
	const h = harness();
	h.track.mockRejectedValueOnce(new Error('offline'));
	await expect(h.service.update(user, guild, false, 0)).rejects.toThrow('offline');
	expect(h.compareAndSet).not.toHaveBeenCalled();
});
it('unconfirmed gateway leaves request failed for safe same-version retry', async () => {
	const h = harness();
	h.sync.mockRejectedValueOnce(new Error('gateway offline'));
	await expect(h.service.update(user, guild, false, 0)).rejects.toThrow('gateway offline');
	expect(h.track).toHaveBeenCalled();
	expect(h.compareAndSet).toHaveBeenCalled();
});
it('other guild and missing scope cannot mutate or create a journal intent', async () => {
	const h = harness();
	await expect(h.service.update(user, createGuildID(21n), true, 0)).rejects.toMatchObject({
		code: 'RESOURCE_NOT_ALLOWED',
	});
	vi.stubEnv('INTEGRATION_GUILD_ID', '');
	await expect(h.service.update(user, guild, true, 0)).rejects.toMatchObject({code: 'RESOURCE_NOT_ALLOWED'});
	expect(h.track).not.toHaveBeenCalled();
});

it('does not mutate authority if synchronous pre-fence is unconfirmed', async () => {
	const h = harness();
	h.begin.mockRejectedValueOnce(new Error('peer unavailable'));
	await expect(h.service.update(user, guild, false, 0)).rejects.toThrow('peer unavailable');
	expect(h.compareAndSet).not.toHaveBeenCalled();
	expect(h.sync).not.toHaveBeenCalled();
});

it('rejects future or stale expectations before creating any fence or durable work', async () => {
	const h = harness();
	await expect(h.service.update(user, guild, false, 100)).rejects.toMatchObject({code: 'STALE_VERSION'});
	expect(h.track).not.toHaveBeenCalled();
	expect(h.begin).not.toHaveBeenCalled();
});
it('recovers a crash after pre-fence but before CAS by completing the exact durable intent', async () => {
	const h = harness();
	h.compareAndSet.mockRejectedValueOnce(new Error('crash before CAS'));
	await expect(h.service.update(user, guild, false, 0)).rejects.toThrow('crash before CAS');
	const [resource, data] = h.track.mock.calls[0] as unknown as [string, Record<string, unknown>];
	expect(h.completePreferenceIntent).not.toHaveBeenCalled();
	await reconcileNsfwPreference(
		data,
		resource,
		{get: h.get, compareAndSet: h.compareAndSet} as unknown as UserGuildNsfwRepository,
		{completePreferenceIntent: h.completePreferenceIntent} as unknown as IntegrationEventJournal,
		h.begin,
		h.sync,
	);
	expect(h.compareAndSet).toHaveBeenCalledTimes(2);
	expect(h.sync).toHaveBeenCalledWith(user, guild, false, 1);
	expect(h.completePreferenceIntent).toHaveBeenCalledWith(resource);
});
it('a durable older intent only synchronizes newer authority and never overwrites it', async () => {
	const h = harness();
	h.get.mockResolvedValueOnce(
		new UserGuildSettings({...defaultGuildNsfwSettings(user, guild).toRow(), show_nsfw: true, nsfw_version: 3n}),
	);
	await reconcileNsfwPreference(
		{user_id: '10', guild_id: '20', expected_version: 0, show_nsfw: false},
		'nsfw:20:10:old',
		{get: h.get, compareAndSet: h.compareAndSet} as unknown as UserGuildNsfwRepository,
		{completePreferenceIntent: h.completePreferenceIntent} as unknown as IntegrationEventJournal,
		h.begin,
		h.sync,
	);
	expect(h.compareAndSet).not.toHaveBeenCalled();
	expect(h.begin).not.toHaveBeenCalled();
	expect(h.sync).toHaveBeenCalledWith(user, guild, true, 3);
});
it('concurrent same-version attempts own separate durable records', async () => {
	const h = harness();
	await Promise.all([h.service.update(user, guild, false, 0), h.service.update(user, guild, false, 0)]);
	const keys = h.track.mock.calls.map((call) => (call as unknown as [string])[0]);
	expect(new Set(keys).size).toBe(2);
	expect(h.completePreferenceIntent).toHaveBeenCalledTimes(2);
});

it('a post-fence CAS loser synchronizes newer authority before returning its conflict', async () => {
	const h = harness();
	h.get
		.mockResolvedValueOnce(defaultGuildNsfwSettings(user, guild))
		.mockResolvedValueOnce(
			new UserGuildSettings({...defaultGuildNsfwSettings(user, guild).toRow(), show_nsfw: true, nsfw_version: 3n}),
		);
	h.compareAndSet.mockRejectedValueOnce(new Error('STALE_VERSION'));
	await expect(h.service.update(user, guild, false, 0)).rejects.toThrow('STALE_VERSION');
	expect(h.sync).toHaveBeenCalledWith(user, guild, true, 3);
	expect(h.completePreferenceIntent).toHaveBeenCalledOnce();
});

it('retains durable recovery when ordinary all-device propagation fails after the native commit', async () => {
	const h = harness();
	h.gateway.dispatchPresence.mockRejectedValueOnce(new Error('presence offline'));
	await expect(h.service.update(user, guild, false, 0)).rejects.toThrow('presence offline');
	expect(h.sync).toHaveBeenCalledWith(user, guild, false, 1);
	expect(h.completePreferenceIntent).not.toHaveBeenCalled();
});
