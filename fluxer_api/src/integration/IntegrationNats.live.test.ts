// SPDX-License-Identifier: AGPL-3.0-or-later

import {readFile} from 'node:fs/promises';
import {createAuthHarness, createTestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createApiContext} from '@app/api/CreateApiContext';
import {IntegrationExchangeRepository} from '@app/integration/IntegrationExchangeRepository';
import {IntegrationIdentityRepository} from '@app/integration/IntegrationIdentityRepository';
import {IntegrationRpcServer} from '@app/integration/IntegrationRpcServer';
import {IntegrationService} from '@app/integration/IntegrationService';
import {connect} from '@nats-io/transport-node';
import {expect, it, vi} from 'vitest';

vi.mock('@app/api/infrastructure/APIReadiness', () => ({
	startAPIReadiness: vi.fn(),
	stopAPIReadiness: vi.fn(),
	apiReady: () => true,
}));

it.skipIf(!process.env.INTEGRATION_LIVE_TEST_CONNECTION)(
	'serves native session resolve and revocation through an isolated real NATS broker',
	async () => {
		const metadata = JSON.parse(await readFile(process.env.INTEGRATION_LIVE_TEST_CONNECTION!, 'utf8')) as {
			port: number;
			forum_password: string;
			fluxer_password: string;
		};
		const harness = await createAuthHarness();
		const serverConnection = await connect({
			servers: `nats://127.0.0.1:${metadata.port}`,
			user: 'fluxer',
			pass: metadata.fluxer_password,
			inboxPrefix: '_INBOX.fluxer',
		});
		const client = await connect({
			servers: `nats://127.0.0.1:${metadata.port}`,
			user: 'forum',
			pass: metadata.forum_password,
			inboxPrefix: '_INBOX.forum',
		});
		const server = new IntegrationRpcServer(
			serverConnection,
			new IntegrationService(createApiContext(), new IntegrationExchangeRepository(Buffer.alloc(32, 1))),
			4,
			['_INBOX.forum.', '_INBOX.bot.'],
		);
		vi.spyOn(IntegrationIdentityRepository.prototype, 'findDiscordId').mockResolvedValue(null);
		try {
			await server.start();
			const account = await createTestAccount(harness);
			const request = JSON.stringify({version: 1, request_id: 'live_request_123456789', token: account.token});
			const resolved = await client.request('rpc.auth.v1.session.resolve', request, {timeout: 3000});
			expect(JSON.parse(resolved.string())).toMatchObject({
				ok: true,
				data: {user_id: account.userId, discord_user_id: null},
			});
			const revoked = await client.request('rpc.auth.v1.session.revoke_current', request, {timeout: 3000});
			expect(JSON.parse(revoked.string())).toEqual({ok: true, data: {revoked: true}});
			const invalid = await client.request('rpc.auth.v1.session.resolve', request, {timeout: 3000});
			expect(JSON.parse(invalid.string())).toMatchObject({ok: false, error: {code: 'INVALID_TOKEN', retryable: false}});
		} finally {
			await server.stop();
			await client.drain();
			await harness.shutdown();
			vi.restoreAllMocks();
		}
	},
);
