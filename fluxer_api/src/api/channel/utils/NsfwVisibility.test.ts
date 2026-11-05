// SPDX-License-Identifier: AGPL-3.0-or-later

import {createChannelID, createGuildID, createUserID} from '@app/api/BrandedTypes';
import type {ChannelRepository} from '@app/api/channel/ChannelRepository';
import {NsfwVisibility} from '@app/api/channel/utils/NsfwVisibility';
import type {GuildRepository} from '@app/api/guild/repositories/GuildRepository';
import type {Channel} from '@app/api/models/Channel';
import type {UserSettingsRepository} from '@app/api/user/repositories/UserSettingsRepository';
import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const guildId = createGuildID(100n);
const userId = createUserID(200n);
function channel(id: bigint, values: Partial<Channel> = {}): Channel {
	return {
		id: createChannelID(id),
		guildId,
		parentId: null,
		type: ChannelTypes.GUILD_TEXT,
		nsfwOverride: null,
		contentWarningLevel: 0,
		contentWarningText: null,
		...values,
	} as Channel;
}
function setup(showNsfw: unknown = null, guildNsfw = false, channels: Array<Channel> = []) {
	const findGuildSettings = vi.fn().mockResolvedValue(showNsfw === null ? null : {showNsfw});
	const findUnique = vi.fn(async (id: bigint) => channels.find((item) => item.id === id) ?? null);
	const findGuild = vi.fn().mockResolvedValue({nsfw: guildNsfw});
	const repository = {channelData: {findUnique}} as unknown as ChannelRepository;
	const guilds = {findUnique: findGuild} as unknown as GuildRepository;
	const settings = {findGuildSettings} as unknown as UserSettingsRepository;
	return {
		visibility: new NsfwVisibility(userId, repository, guilds, settings),
		findGuildSettings,
		findUnique,
		findGuild,
		fresh: () => new NsfwVisibility(userId, repository, guilds, settings),
	};
}

beforeEach(() => vi.stubEnv('INTEGRATION_GUILD_ID', guildId.toString()));
afterEach(() => vi.unstubAllEnvs());

describe('authoritative per-user NSFW display visibility', () => {
	it.each([null, false, undefined, 1, 'true', 'false'])(
		'hides NSFW unless preference is strictly true: %s',
		async (value) => {
			const {visibility} = setup(value);
			await expect(visibility.assertVisible(channel(1n, {nsfwOverride: true}))).rejects.toMatchObject({status: 404});
			await expect(visibility.isVisible(channel(2n, {nsfwOverride: false}))).resolves.toBe(true);
		},
	);
	it('true removes only the display restriction', async () => {
		const {visibility, findGuild} = setup(true);
		await expect(visibility.isVisible(channel(1n, {nsfwOverride: true}))).resolves.toBe(true);
		expect(findGuild).not.toHaveBeenCalled();
	});
	it.each(['101', '0100', ' 100 ', ''])('does not read or affect other/misconfigured guilds: %s', async (target) => {
		vi.stubEnv('INTEGRATION_GUILD_ID', target);
		const {visibility, findGuildSettings, findGuild} = setup(false);
		await expect(visibility.isVisible(channel(1n, {nsfwOverride: true}))).resolves.toBe(true);
		expect(findGuildSettings).not.toHaveBeenCalled();
		expect(findGuild).not.toHaveBeenCalled();
	});
	it('has no effect on direct messages', async () => {
		const {visibility, findGuildSettings} = setup(false);
		await expect(visibility.isVisible(channel(1n, {guildId: null, nsfwOverride: true}))).resolves.toBe(true);
		expect(findGuildSettings).not.toHaveBeenCalled();
	});
	it('inherits category and guild NSFW, with explicit safe overrides preserved', async () => {
		const category = channel(1n, {type: ChannelTypes.GUILD_CATEGORY, nsfwOverride: true});
		const parent = channel(2n, {parentId: category.id});
		const thread = channel(3n, {type: ChannelTypes.PUBLIC_THREAD, parentId: parent.id, nsfwOverride: false});
		const safe = channel(4n, {parentId: category.id, nsfwOverride: false});
		const s = setup(false, false, [category, parent]);
		expect(await s.visibility.filter([category, parent, thread, safe])).toEqual([safe]);
		expect(s.findGuildSettings).toHaveBeenCalledExactlyOnceWith(userId, guildId);
		expect(s.findGuild).toHaveBeenCalledOnce();
		await expect(setup(false, true).visibility.isVisible(channel(5n))).resolves.toBe(false);
	});
	it('does not use a cross-guild parent or expose an orphan thread', async () => {
		const parent = channel(1n, {guildId: createGuildID(999n), nsfwOverride: false});
		const thread = channel(2n, {type: ChannelTypes.PRIVATE_THREAD, parentId: parent.id});
		await expect(setup(false, false, [parent]).visibility.isVisible(thread)).resolves.toBe(false);
		await expect(setup(false).visibility.isVisible(thread)).resolves.toBe(false);
	});
	it('uses a fresh authoritative setting on the next request', async () => {
		const s = setup(false);
		const nsfw = channel(1n, {nsfwOverride: true});
		await expect(s.visibility.isVisible(nsfw)).resolves.toBe(false);
		s.findGuildSettings.mockResolvedValue({showNsfw: true});
		await expect(s.fresh().isVisible(nsfw)).resolves.toBe(true);
		expect(s.findGuildSettings).toHaveBeenCalledTimes(2);
	});
	it.each(['setting', 'guild', 'parent'])(
		'reports a dependency failure, never pretend-404/success: %s',
		async (failed) => {
			const s = setup(false);
			if (failed === 'setting') s.findGuildSettings.mockRejectedValue(new Error('offline'));
			if (failed === 'guild') s.findGuild.mockRejectedValue(new Error('offline'));
			if (failed === 'parent') s.findUnique.mockRejectedValue(new Error('offline'));
			const target = channel(1n, {nsfwOverride: true, parentId: failed === 'parent' ? createChannelID(2n) : null});
			await expect(s.visibility.assertVisible(target)).rejects.toMatchObject({status: 503});
		},
	);
});
