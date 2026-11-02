// SPDX-License-Identifier: AGPL-3.0-or-later

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.hoisted(() => {
	vi.resetModules();
});

const testState = vi.hoisted(() => ({
	pending: new Map<string, {shard: number; key: string; subject: string; payload: string}>(),
	publish: vi.fn(),
	enqueue: vi.fn(),
	liveSession: false,
	creation: vi.fn(),
	superseded: vi.fn(),
	regenerate: vi.fn(),
	failCreation: vi.fn(),
	sessionReadError: false,
}));
vi.mock('@app/api/Logger', () => ({Logger: {warn: vi.fn()}}));
vi.mock('@app/integration/IntegrationIdentityRepository', () => ({INTEGRATION_QUERY_OPTIONS: {prepare: true}}));
vi.mock('@app/integration/IntegrationReconciliation', () => ({
	IntegrationReconciliation: class {
		step = vi.fn();
	},
}));
vi.mock('@app/integration/IntegrationContentEvents', () => ({projectIntegrationContent: testState.regenerate}));
vi.mock('@app/integration/IntegrationCreationEventGate', () => ({
	IntegrationCreationEventGate: class {
		status = testState.creation;
	},
}));
vi.mock('@app/integration/IntegrationEventJournal', () => ({
	IntegrationEventJournal: class {
		enqueue = testState.enqueue;
		superseded = testState.superseded;
		resource = async () => ({guild_id: '1', channel_id: '2', thread_id: '11', creation_operation_id: 'create-1'});
		failCreation = testState.failCreation;
		pending = async (shard: number) => [...testState.pending.values()].filter((event) => event.shard === shard);
		tracked = async () => [];
		acknowledge = async (event: {key: string}) => {
			testState.pending.delete(event.key);
		};
	},
}));
vi.mock('@nats-io/transport-node', () => ({connect: vi.fn(async () => ({drain: vi.fn()}))}));
vi.mock('@nats-io/jetstream', () => ({jetstream: () => ({publish: testState.publish})}));
vi.mock('@pkgs/cassandra/src/Client', () => ({
	getClient: () => ({
		execute: async () => {
			if (testState.sessionReadError) throw new Error('authority offline');
			return {first: () => (testState.liveSession ? {created_at: new Date()} : undefined)};
		},
	}),
}));

import {
	publishIntegrationEvent,
	recoverIntegrationEventsPage,
	shutdownIntegrationEvents,
	startIntegrationEvents,
} from '@app/integration/IntegrationEvents';

/** 用完整分片循环验证恢复不依赖进程内上次发布的游标位置 */
async function recoverAll(): Promise<void> {
	for (let index = 0; index < 16; index++) await recoverIntegrationEventsPage();
}

describe('durable integration delivery', () => {
	beforeEach(() => {
		testState.pending.clear();
		testState.publish.mockReset();
		testState.enqueue.mockReset();
		testState.liveSession = false;
		testState.sessionReadError = false;
		testState.creation.mockReset().mockResolvedValue('ready');
		testState.superseded.mockReset().mockResolvedValue(false);
		testState.regenerate.mockReset();
		testState.failCreation.mockReset().mockImplementation(async () => {
			testState.pending.clear();
		});
		vi.stubEnv('INTEGRATION_NATS_URL', 'nats://test');
	});
	afterEach(async () => {
		await shutdownIntegrationEvents();
		vi.unstubAllEnvs();
	});
	it('keeps a failed publish durable and replays the same event ID after broker recovery', async () => {
		const payload = JSON.stringify({event_id: 'thread:11:7', state_version: 7});
		testState.pending.set('p:thread:11:7', {
			shard: 3,
			key: 'p:thread:11:7',
			subject: 'events.content.v1.thread.changed',
			payload,
		});
		testState.publish.mockRejectedValue(new Error('broker offline'));
		await recoverAll();
		expect(testState.pending.size).toBe(1);
		testState.publish.mockResolvedValue({seq: 10});
		await recoverAll();
		expect(testState.pending.size).toBe(0);
		expect(testState.publish).toHaveBeenLastCalledWith('events.content.v1.thread.changed', payload, {
			msgID: 'thread:11:7',
			timeout: 3000,
		});
	});
	it('does not send a precommitted session revocation before the authoritative session is gone', async () => {
		testState.liveSession = true;
		const payload = JSON.stringify({event_id: 'revocation:1', user_id: '11', session_id_hash: 'aGFzaA'});
		testState.pending.set('p:revocation:1', {
			shard: 4,
			key: 'p:revocation:1',
			subject: 'events.auth.v1.session_invalidated',
			payload,
		});
		await recoverAll();
		expect(testState.publish).not.toHaveBeenCalled();
		expect(testState.pending.size).toBe(1);
		testState.liveSession = false;
		testState.publish.mockResolvedValue({seq: 11});
		await recoverAll();
		expect(testState.pending.size).toBe(0);
	});
	it('propagates journal storage failure instead of acknowledging best-effort publication', async () => {
		// 前一个测试退出过后重新初始化生命周期，但不运行真实计时器。
		vi.useFakeTimers();
		startIntegrationEvents();
		testState.enqueue.mockRejectedValue(new Error('journal unavailable'));
		await expect(publishIntegrationEvent('events.auth.v1.user_invalidated', {user_id: '11'})).rejects.toThrow(
			'journal unavailable',
		);
		expect(testState.publish).not.toHaveBeenCalled();
		vi.useRealTimers();
	});
	it('holds old precommit creation snapshots and regenerates authority after the same operation succeeds', async () => {
		const data = {event_id: 'thread:11:7', thread_id: '11', state_version: 7, creation_operation_id: 'create-1'};
		testState.pending.set('p:thread:11:7', {
			shard: 3,
			key: 'p:thread:11:7',
			subject: 'events.content.v1.thread.deleted',
			payload: JSON.stringify(data),
		});
		testState.creation.mockResolvedValue('pending');
		await recoverAll();
		expect(testState.pending.size).toBe(1);
		expect(testState.publish).not.toHaveBeenCalled();
		testState.creation.mockResolvedValue('ready');
		await recoverAll();
		expect(testState.regenerate).toHaveBeenCalledOnce();
		expect(testState.pending.size).toBe(0);
		expect(testState.publish).not.toHaveBeenCalled();
	});
	it('discards superseded versions and terminal failed creation snapshots without publishing either', async () => {
		const event = {
			shard: 3,
			key: 'p:thread:11:7',
			subject: 'events.content.v1.thread.changed',
			payload: JSON.stringify({
				event_id: 'thread:11:7',
				thread_id: '11',
				state_version: 7,
				creation_operation_id: 'create-1',
				creation_completed: true,
			}),
		};
		testState.pending.set(event.key, event);
		testState.superseded.mockResolvedValue(true);
		await recoverAll();
		expect(testState.pending.size).toBe(0);
		expect(testState.publish).not.toHaveBeenCalled();
		testState.pending.set(event.key, event);
		testState.superseded.mockResolvedValue(false);
		testState.creation.mockResolvedValue('failed');
		await recoverAll();
		expect(testState.failCreation).toHaveBeenCalledWith('thread:11', 'create-1');
		expect(testState.publish).not.toHaveBeenCalled();
	});
	it('keeps auth recovery pending while authority is unavailable and persists late shutdown revocations', async () => {
		const event = {
			shard: 3,
			key: 'p:auth:11',
			subject: 'events.auth.v1.session_invalidated',
			payload: JSON.stringify({event_id: 'auth:11', user_id: '11', session_id_hash: 'aGFzaA'}),
		};
		testState.pending.set(event.key, event);
		testState.sessionReadError = true;
		await recoverAll();
		expect(testState.pending.size).toBe(1);
		expect(testState.publish).not.toHaveBeenCalled();
		testState.sessionReadError = false;
		testState.publish.mockResolvedValue({seq: 12});
		await recoverAll();
		expect(testState.pending.size).toBe(0);
		await shutdownIntegrationEvents();
		await publishIntegrationEvent(
			'events.auth.v1.session_invalidated',
			{user_id: '11', session_id_hash: 'aGFzaA'},
			{defer: true},
		);
		expect(testState.enqueue).toHaveBeenCalledOnce();
	});
});
