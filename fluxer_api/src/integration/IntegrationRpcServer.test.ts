// SPDX-License-Identifier: AGPL-3.0-or-later

import {IntegrationRpcServer} from '@app/integration/IntegrationRpcServer';
import type {IntegrationService} from '@app/integration/IntegrationService';
import type {Msg, NatsConnection, SubscriptionOptions} from '@nats-io/transport-node';
import {MissingPermissionsError} from '@fluxer/errors/src/domains/core/MissingPermissionsError';
import {describe, expect, it, vi} from 'vitest';

/** 建立仅模拟传输的请求分发环境 */
function fixture(maxInflight = 2) {
	const callbacks = new Map<string, NonNullable<SubscriptionOptions['callback']>>();
	const unsubscribe = vi.fn();
	const drain = vi.fn().mockResolvedValue(undefined);
	const connection = {
		subscribe: vi.fn((subject: string, options: SubscriptionOptions) => {
			callbacks.set(subject, options.callback!);
			return {unsubscribe};
		}),
		flush: vi.fn().mockResolvedValue(undefined),
		drain,
	} as unknown as NatsConnection;
	const dispatch = vi.fn().mockResolvedValue({token: 'secret'});
	const service = {dispatch} as unknown as IntegrationService;
	const server = new IntegrationRpcServer(connection, service, maxInflight, ['_INBOX.forum.', '_INBOX.bot.']);
	const send = (subject: string, reply: string, payload = '{}') => {
		const respond = vi.fn();
		callbacks.get(subject)!(null, {subject, reply, data: new TextEncoder().encode(payload), respond} as unknown as Msg);
		return respond;
	};
	return {server, send, dispatch, unsubscribe, drain, connection};
}

describe('Integration RPC boundaries', () => {
	it('never dispatches credentials to arbitrary or Bot reply subjects', async () => {
		const {server, send, dispatch} = fixture();
		await server.start();
		const wrongSubject = send('rpc.auth.v1.external.exchange', 'events.auth.v1.session_invalidated');
		const botSubject = send('rpc.auth.v1.external.exchange', '_INBOX.bot.stolen');
		const wildcard = send('rpc.auth.v1.external.exchange', '_INBOX.forum.>');
		const botRebind = send('rpc.identity.v1.rebind_service', '_INBOX.bot.stolen');
		const botContent = send('rpc.content.v1.thread.create_service', '_INBOX.bot.stolen');
		await server.stop();
		expect(dispatch).not.toHaveBeenCalled();
		expect(wrongSubject).not.toHaveBeenCalled();
		expect(botSubject).not.toHaveBeenCalled();
		expect(wildcard).not.toHaveBeenCalled();
		expect(botRebind).not.toHaveBeenCalled();
		expect(botContent).not.toHaveBeenCalled();
	});

	it('returns native authorization failures as terminal errors instead of dependency outages', async () => {
		const {server, send, dispatch} = fixture();
		dispatch.mockRejectedValue(new MissingPermissionsError());
		await server.start();
		const response = send('rpc.content.v1.starter.edit_service', '_INBOX.forum.one');
		await server.stop();
		expect(JSON.parse(response.mock.calls[0]![0])).toMatchObject({ok: false, error: {code: 'MISSING_PERMISSIONS', retryable: false}});
	});

	it('rejects malformed and oversized requests before business work', async () => {
		const {server, send, dispatch} = fixture(10);
		await server.start();
		const invalid = send('rpc.identity.v1.ensure_discord', '_INBOX.bot.one', '{broken');
		const oversized = send('rpc.identity.v1.ensure_discord', '_INBOX.bot.two', 'x'.repeat(16_385));
		await server.stop();
		expect(dispatch).not.toHaveBeenCalled();
		expect(JSON.parse(invalid.mock.calls[0]![0])).toMatchObject({
			ok: false,
			error: {code: 'INVALID_REQUEST', retryable: false},
		});
		expect(JSON.parse(oversized.mock.calls[0]![0])).toMatchObject({ok: false, error: {code: 'INVALID_REQUEST'}});
	});

	it('bounds concurrency, uses queue groups, and drains accepted work before closing', async () => {
		const {server, send, dispatch, drain, connection} = fixture(1);
		let release!: () => void;
		dispatch.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		await server.start();
		const accepted = send('rpc.auth.v1.session.resolve', '_INBOX.forum.one');
		const rejected = send('rpc.auth.v1.session.resolve', '_INBOX.forum.two');
		expect(JSON.parse(rejected.mock.calls[0]![0])).toMatchObject({error: {code: 'BUSY', retryable: true}});
		const stopping = server.stop();
		expect(drain).not.toHaveBeenCalled();
		release();
		await stopping;
		expect(accepted).toHaveBeenCalled();
		expect(drain).toHaveBeenCalledOnce();
		expect(connection.subscribe).toHaveBeenCalledWith(
			'rpc.auth.v1.session.resolve',
			expect.objectContaining({queue: 'fluxer-integration-v1'}),
		);
	});
});
