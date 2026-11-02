// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ApiContext} from '@app/api/ApiContext';
import {IntegrationError} from '@app/integration/IntegrationError';
import type {IntegrationExchangeRepository} from '@app/integration/IntegrationExchangeRepository';
import {IntegrationSchemas} from '@app/integration/IntegrationSchemas';
import {IntegrationService} from '@app/integration/IntegrationService';
import {UserFlags} from '@fluxer/constants/src/UserConstants';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const state = vi.hoisted(() => ({
	binding: {state: 'ready', user_id: 202n} as {state: string; user_id: bigint} | null,
	current: ['11'] as Array<string | null>,
	versions: [5] as Array<number>,
	identityError: null as Error | null,
	user: null as Record<string, unknown> | null,
}));
vi.mock('@app/api/Config', () => ({Config: {instance: {selfHosted: false}}}));
vi.mock('@app/api/auth/AuthSession', () => ({}));
vi.mock('@app/api/auth/AuthSessionRevocation', () => ({revokeAuthSessions: vi.fn()}));
vi.mock('@app/api/auth/AuthUtility', () => ({generateAuthToken: vi.fn()}));
vi.mock('@app/integration/DiscordAccountService', () => ({DiscordAccountService: class {}}));
vi.mock('@app/integration/DiscordPasswordProof', () => ({issueDiscordPasswordProof: vi.fn()}));
vi.mock('@app/integration/IdentityRebindService', () => ({IdentityRebindService: class {}}));
vi.mock('@app/integration/IntegrationContentService', () => ({IntegrationContentService: class {}}));
vi.mock('@app/api/user/repositories/auth/AuthSessionRepository', () => ({
	AuthSessionRepository: class {
		async getAuthoritativeAuthSession() {
			return {userId: 202n};
		}
	},
}));
vi.mock('@app/integration/IntegrationIdentityRepository', () => ({
	IntegrationIdentityRepository: class {
		async find() {
			if (state.identityError) throw state.identityError;
			return state.binding;
		}
		async canonicalUserId(id: bigint) {
			return id;
		}
		async bindingVersion() {
			return state.versions.length > 1 ? state.versions.shift()! : state.versions[0];
		}
		async findDiscordId() {
			if (state.identityError) throw state.identityError;
			return state.current.length > 1 ? state.current.shift()! : state.current[0];
		}
	},
}));

const subject = 'rpc.identity.v1.login_eligibility';
const request = {version: 1, request_id: 'eligibility_request_1', discord_user_id: '11'};
function service() {
	return new IntegrationService(
		{services: {users: {findUnique: async () => state.user}}} as unknown as ApiContext,
		{} as IntegrationExchangeRepository,
	);
}
describe('legacy Discord login eligibility', () => {
	beforeEach(() => {
		state.binding = {state: 'ready', user_id: 202n};
		state.current = ['11'];
		state.versions = [5];
		state.identityError = null;
		state.user = {
			id: 202n,
			isBot: false,
			flags: 0n,
			traits: new Set(['discord_integration']),
			deletionStartedAt: null,
			tempBannedUntil: null,
		};
	});
	it('returns only the current bound identity and native account eligibility without session credentials', async () => {
		expect(await service().dispatch(subject, request)).toEqual({
			discord_user_id: '11',
			user_id: '202',
			identity_version: 5,
			current: true,
			eligible: true,
		});
	});
	it('distinguishes an absent binding from a historical identity', async () => {
		state.binding = null;
		expect(await service().dispatch(subject, request)).toEqual({
			discord_user_id: '11',
			user_id: null,
			identity_version: null,
			current: false,
			eligible: false,
		});
		state.binding = {state: 'ready', user_id: 202n};
		state.current = ['12'];
		expect(await service().dispatch(subject, request)).toEqual({
			discord_user_id: '11',
			user_id: '202',
			identity_version: 5,
			current: false,
			eligible: false,
		});
	});
	it('uses the same unavailable account predicate as native session resolution', async () => {
		const active = state.user!;
		for (const change of [
			null,
			{isBot: true},
			{flags: UserFlags.DISABLED},
			{flags: UserFlags.SELF_DELETED},
			{flags: UserFlags.DELETED},
			{deletionStartedAt: new Date()},
			{traits: new Set(['registration_pending_approval'])},
			{traits: new Set(['registration_rejected'])},
			{flags: UserFlags.DISABLED, tempBannedUntil: new Date(Date.now() + 60_000)},
		]) {
			state.user = change === null ? null : {...active, ...change};
			expect(await service().dispatch(subject, request)).toMatchObject({current: true, eligible: false});
			await expect(service().resolve('synthetic-token')).rejects.toMatchObject({code: 'ACCOUNT_UNAVAILABLE'});
		}
	});
	it('keeps incomplete binding, changing identity and invalid version unavailable, never eligible', async () => {
		state.binding!.state = 'pending';
		await expect(service().dispatch(subject, request)).rejects.toMatchObject({code: 'IDENTITY_BUSY', retryable: true});
		state.binding!.state = 'ready';
		state.current = ['11', '12'];
		await expect(service().dispatch(subject, request)).rejects.toMatchObject({code: 'IDENTITY_BUSY', retryable: true});
		state.current = ['11'];
		state.versions = [5, 6];
		await expect(service().dispatch(subject, request)).rejects.toMatchObject({code: 'IDENTITY_BUSY', retryable: true});
		state.versions = [Number.NaN];
		await expect(service().dispatch(subject, request)).rejects.toMatchObject({code: 'UNAVAILABLE', retryable: true});
	});
	it('does not convert authority errors to a known negative or an eligible response', async () => {
		state.identityError = new IntegrationError('IDENTITY_BUSY', 'fixed', true);
		await expect(service().dispatch(subject, request)).rejects.toMatchObject({code: 'IDENTITY_BUSY', retryable: true});
		state.identityError = Error('synthetic dependency unavailable');
		await expect(service().dispatch(subject, request)).rejects.toThrow('synthetic dependency unavailable');
	});
	it('rejects extra identity assertions and malformed protocol fields', () => {
		expect(() => IntegrationSchemas[subject].parse({...request, eligible: true})).toThrow();
		expect(() => IntegrationSchemas[subject].parse({...request, discord_user_id: '0'})).toThrow();
		expect(() => IntegrationSchemas[subject].parse({...request, version: 2})).toThrow();
	});
});
