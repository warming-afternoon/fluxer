// SPDX-License-Identifier: AGPL-3.0-or-later

import {KVClient} from '@pkgs/kv_client/src/KVClient';
import {KVSubscription} from '@pkgs/kv_client/src/KVSubscription';
import {expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => ({clients: [] as Array<any>, constructors: [] as Array<any>}));
vi.mock('ioredis', async () => {
	const {EventEmitter} = await import('node:events');
	class MockRedis extends EventEmitter {
		status = 'ready';
		subscribe = vi.fn(async () => 1);
		disconnect = vi.fn();
		constructor(...args: Array<unknown>) {
			super();
			mocks.clients.push(this);
			mocks.constructors.push(args);
		}
	}
	return {default: MockRedis, Cluster: MockRedis};
});

it('only disables offline queues for an explicitly configured client', () => {
	new KVClient({url: 'redis://127.0.0.1', timeoutMs: 250, enableOfflineQueue: false});
	expect(mocks.constructors.at(-1)[1]).toMatchObject({commandTimeout: 250, enableOfflineQueue: false});
	new KVClient('redis://127.0.0.1');
	expect(mocks.constructors.at(-1)[1]).not.toHaveProperty('enableOfflineQueue');
});

it('reports disconnect and only reports recovery after resubscription succeeds', async () => {
	const state = vi.fn();
	const subscription = new KVSubscription({
		url: 'redis://127.0.0.1',
		timeoutMs: 250,
		logger: {debug() {}, error() {}},
		onStateChange: state,
	});
	await subscription.subscribe('metadata');
	await subscription.connect();
	const client = mocks.clients.at(-1);
	client.emit('close');
	expect(state).toHaveBeenLastCalledWith(false);
	const gate = Promise.withResolvers<number>();
	client.subscribe.mockReturnValueOnce(gate.promise);
	client.emit('ready');
	expect(state).toHaveBeenLastCalledWith(false);
	gate.resolve(1);
	await vi.waitFor(() => expect(state).toHaveBeenLastCalledWith(true));
	await subscription.disconnect();
});
