// SPDX-License-Identifier: AGPL-3.0-or-later
import {beforeEach, describe, expect, it, vi} from 'vitest';

const {patch} = vi.hoisted(() => ({patch: vi.fn()}));
vi.mock('../src/features/channel/state/Channels', () => ({default: {getChannel: vi.fn()}}));
vi.mock('../src/features/guild/state/Guilds', () => ({default: {getGuild: vi.fn()}}));
vi.mock('../src/features/user/state/AdvancedSettings', () => ({default: {}}));
vi.mock('../src/features/platform/utils/AppLogger', () => ({
	Logger: class {
		debug() {}
		error() {}
	},
}));
vi.mock('../src/features/platform/transport/RestTransport', () => ({http: {patch}}));

import {updateNsfwVisibility} from '../src/features/user/commands/UserGuildSettingsCommands';
import UserGuildSettings from '../src/features/user/state/UserGuildSettings';

beforeEach(() => {
	UserGuildSettings.handleGatewayReady([]);
	patch.mockReset();
});
describe('independent NSFW display settings', () => {
	it('keeps other guilds unscoped until explicit server response', () => {
		expect(UserGuildSettings.getSettingsForScope('other').show_nsfw).toBeUndefined();
	});
	it('ignores stale preference fields but accepts independent notification fields', () => {
		UserGuildSettings.handleUserGuildSettingsUpdate({guild_id: '20', show_nsfw: false, nsfw_version: 2});
		UserGuildSettings.handleUserGuildSettingsUpdate({guild_id: '20', show_nsfw: true, nsfw_version: 1, muted: true});
		expect(UserGuildSettings.getSettingsForScope('20')).toMatchObject({show_nsfw: false, nsfw_version: 2, muted: true});
	});
	it('denies same-version conflicting grants', () => {
		UserGuildSettings.handleUserGuildSettingsUpdate({guild_id: '20', show_nsfw: false, nsfw_version: 2});
		UserGuildSettings.handleUserGuildSettingsUpdate({guild_id: '20', show_nsfw: true, nsfw_version: 2});
		expect(UserGuildSettings.getSettingsForScope('20').show_nsfw).toBe(false);
	});
	it('sends a separate exact-CAS patch and applies only confirmed authority', async () => {
		patch.mockResolvedValue({body: {guild_id: '20', show_nsfw: true, nsfw_version: 3}});
		await updateNsfwVisibility('20', true, 2);
		expect(patch).toHaveBeenCalledWith('/users/@me/guilds/20/settings', {body: {show_nsfw: true, nsfw_version: 2}});
		expect(UserGuildSettings.getSettingsForScope('20').show_nsfw).toBe(true);
	});
	it.each([
		undefined,
		{},
		{guild_id: '21', show_nsfw: true, nsfw_version: 3},
		{guild_id: '20', show_nsfw: false, nsfw_version: 3},
		{guild_id: '20', show_nsfw: true, nsfw_version: 2},
	])('rejects missing/malformed/stale acknowledgement %#', async (body) => {
		patch.mockResolvedValue({body});
		await expect(updateNsfwVisibility('20', true, 2)).rejects.toThrow('acknowledgement');
		expect(UserGuildSettings.getSettingsForScope('20').show_nsfw).toBeUndefined();
	});
	it('does not optimistically apply a failed change', async () => {
		patch.mockRejectedValue(new Error('offline'));
		await expect(updateNsfwVisibility('20', true, 2)).rejects.toThrow('offline');
		expect(UserGuildSettings.getSettingsForScope('20').show_nsfw).toBeUndefined();
	});
});
