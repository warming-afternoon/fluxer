// SPDX-License-Identifier: AGPL-3.0-or-later
import type {ApiContext} from '@app/api/ApiContext';
import * as AgeUtils from '@app/api/utils/AgeUtils';
import type {IntegrationExchangeRepository} from '@app/integration/IntegrationExchangeRepository';
import {IntegrationSchemas} from '@app/integration/IntegrationSchemas';
import {IntegrationService} from '@app/integration/IntegrationService';
import {UserFlags} from '@fluxer/constants/src/UserConstants';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';

const state = vi.hoisted(() => ({
	user: null as Record<string, unknown> | null,
	member: true,
	eligible: true,
	get: vi.fn(),
	update: vi.fn(),
}));
vi.mock('@app/integration/DiscordAccountService', () => ({DiscordAccountService: class {}}));
vi.mock('@app/api/middleware/ServiceSingletons', () => ({
	getGuildRepository: () => ({getMember: async () => (state.member ? {} : null)}),
}));

vi.mock('@app/api/user/repositories/UserGuildNsfwRepository', () => ({
	UserGuildNsfwRepository: class {
		get(...args: Array<unknown>) {
			return state.get(...args);
		}
	},
}));
vi.mock('@app/api/user/NsfwDisplayPreferenceService', () => ({
	NsfwDisplayPreferenceService: class {
		update(...args: Array<unknown>) {
			return state.update(...args);
		}
	},
}));
const request = {version: 1, request_id: 'request_preferences_123', actor_user_id: '10', guild_id: '20'};
function service() {
	return new IntegrationService(
		{services: {users: {findUnique: async () => state.user}, gateway: {}}} as unknown as ApiContext,
		{} as IntegrationExchangeRepository,
	);
}
beforeEach(() => {
	vi.spyOn(AgeUtils, 'canUserAccessNsfwContent').mockImplementation(() => state.eligible);
	vi.stubEnv('INTEGRATION_GUILD_ID', '20');
	state.user = {id: 10n, isBot: false, flags: 0n, traits: new Set(), deletionStartedAt: null, tempBannedUntil: null};
	state.member = true;
	state.eligible = true;
	state.get.mockReset().mockResolvedValue({showNsfw: true, nsfwVersion: 3});
	state.update.mockReset().mockResolvedValue({showNsfw: false, nsfwVersion: 4});
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});
it('returns raw display preference separately from independently computed eligibility', async () => {
	state.eligible = false;
	expect(await service().dispatch('rpc.preferences.v1.get_service', request)).toEqual({
		guild_id: '20',
		show_nsfw: true,
		nsfw_eligible: false,
		version: 3,
	});
});
it('writes only the authenticated actor and exact configured guild using the expected CAS version', async () => {
	expect(
		await service().dispatch('rpc.preferences.v1.update_service', {...request, show_nsfw: false, expected_version: 3}),
	).toEqual({guild_id: '20', show_nsfw: false, nsfw_eligible: true, version: 4});
	expect(state.update).toHaveBeenCalledWith(10n, 20n, false, 3);
});
it('never reads or mutates a different or missing configured guild', async () => {
	await expect(
		service().dispatch('rpc.preferences.v1.get_service', {...request, guild_id: '21'}),
	).rejects.toMatchObject({code: 'RESOURCE_NOT_ALLOWED'});
	vi.stubEnv('INTEGRATION_GUILD_ID', '');
	await expect(service().dispatch('rpc.preferences.v1.get_service', request)).rejects.toMatchObject({
		code: 'RESOURCE_NOT_ALLOWED',
	});
	expect(state.get).not.toHaveBeenCalled();
});
it('requires current membership and available native account before disclosing the preference', async () => {
	state.member = false;
	await expect(service().dispatch('rpc.preferences.v1.get_service', request)).rejects.toMatchObject({
		code: 'RESOURCE_NOT_ALLOWED',
	});
	state.member = true;
	state.user!.flags = UserFlags.DISABLED;
	await expect(service().dispatch('rpc.preferences.v1.get_service', request)).rejects.toMatchObject({
		code: 'ACCOUNT_UNAVAILABLE',
	});
	expect(state.get).not.toHaveBeenCalled();
});
it('propagates unavailable storage rather than defaulting to an allowed preference', async () => {
	state.get.mockRejectedValue(new Error('offline'));
	await expect(service().dispatch('rpc.preferences.v1.get_service', request)).rejects.toThrow('offline');
});
it.each([true, 'true', null, -1, 1.5, Number.MAX_SAFE_INTEGER])('rejects invalid expected version %#', (version) => {
	expect(() =>
		IntegrationSchemas['rpc.preferences.v1.update_service'].parse({
			...request,
			show_nsfw: true,
			expected_version: version,
		}),
	).toThrow();
});
it.each(['true', 1, null, {}, []])('rejects nonboolean show preference %#', (show) => {
	expect(() =>
		IntegrationSchemas['rpc.preferences.v1.update_service'].parse({...request, show_nsfw: show, expected_version: 3}),
	).toThrow();
});
it('rejects extra identity, permissions and eligibility inputs', () => {
	expect(() =>
		IntegrationSchemas['rpc.preferences.v1.update_service'].parse({
			...request,
			show_nsfw: true,
			expected_version: 3,
			nsfw_eligible: true,
			target_user_id: '11',
		}),
	).toThrow();
});
