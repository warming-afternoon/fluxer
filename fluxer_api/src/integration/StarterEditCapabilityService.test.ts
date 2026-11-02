// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID} from '@app/api/BrandedTypes';
import type {AuthenticatedChannel} from '@app/api/channel/services/AuthenticatedChannel';
import type {Message} from '@app/api/models/Message';
import type {UserRepository} from '@app/api/user/repositories/UserRepository';
import type {IntegrationIdentityRepository} from '@app/integration/IntegrationIdentityRepository';
import type {IntegrationOperationRepository} from '@app/integration/IntegrationOperationRepository';
import {withIntegrationStarterEditScope} from '@app/integration/IntegrationStarterEditContext';
import {StarterEditCapabilityService} from '@app/integration/StarterEditCapabilityService';
import {UserFlags} from '@fluxer/constants/src/UserConstants';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const actor = createUserID(202n);
const scope = {actorUserId: '202', guildId: '1', threadId: '303'};

function fixture() {
	const allocate = vi.fn().mockResolvedValue({});
	const service = new StarterEditCapabilityService(
		{
			findUnique: vi.fn().mockResolvedValue({traits: new Set(['discord_integration']), flags: UserFlags.DISABLED}),
		} as unknown as UserRepository,
		{canonicalUserId: vi.fn().mockResolvedValue(actor)} as unknown as IntegrationIdentityRepository,
		{allocate} as unknown as IntegrationOperationRepository,
	);
	const auth = {
		channel: {id: 303n, guildId: 1n},
		thread: {state: {hasStarter: true}, parent: {id: 10n, isThreadOnly: () => true}},
	} as unknown as AuthenticatedChannel;
	const message = {id: 303n, channelId: 303n, authorId: 101n, content: 'before', attachments: []} as unknown as Message;
	const call = () => service.authorize(actor, auth, message, {content: 'after'});
	return {auth, message, allocate, call};
}

describe('merged starter editing boundary', () => {
	beforeEach(() => {
		vi.stubEnv('FLUXER_THREAD_POLICY_ENABLED', 'true');
		vi.stubEnv('INTEGRATION_GUILD_ID', '1');
		vi.stubEnv('INTEGRATION_FORUM_CHANNEL_IDS', '10,11,12,13');
	});
	afterEach(() => vi.unstubAllEnvs());
	it('does not grant the internal capability to ordinary HTTP', async () => {
		const {call, allocate} = fixture();
		expect(await call()).toBeNull();
		expect(allocate).not.toHaveBeenCalled();
	});
	it('retains the trusted Forum edit with actual and original author audit', async () => {
		const {call, allocate} = fixture();
		expect(await withIntegrationStarterEditScope(scope, call)).toMatch(/^starter_edit_/);
		expect(JSON.parse(allocate.mock.calls[0]![0].payload)).toMatchObject({
			actor_user_id: '202',
			original_author_id: '101',
			before_content: 'before',
			after_content: 'after',
		});
	});
	it('binds actor, thread, guild and the currently allowed parent forum', async () => {
		for (const changed of [{actorUserId: '203'}, {threadId: '304'}, {guildId: '2'}]) {
			const {call} = fixture();
			expect(await withIntegrationStarterEditScope({...scope, ...changed}, call)).toBeNull();
		}
		const {auth, call} = fixture();
		Object.assign(auth.thread!.parent, {id: 99n});
		expect(await withIntegrationStarterEditScope(scope, call)).toBeNull();
	});
	it('cleans the context after async completion or rejection without crossing concurrent requests', async () => {
		const {call} = fixture();
		const [inside, outside] = await Promise.all([
			withIntegrationStarterEditScope(scope, async () => {
				await Promise.resolve();
				return call();
			}),
			call(),
		]);
		expect(inside).toMatch(/^starter_edit_/);
		expect(outside).toBeNull();
		await expect(
			withIntegrationStarterEditScope(scope, async () => {
				throw Error('fixed');
			}),
		).rejects.toThrow('fixed');
		expect(await call()).toBeNull();
	});
});
