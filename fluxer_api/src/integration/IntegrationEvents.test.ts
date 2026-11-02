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
}));
vi.mock('@app/api/Logger', () => ({Logger: {warn: vi.fn()}}));
vi.mock('@app/integration/IntegrationIdentityRepository', () => ({INTEGRATION_QUERY_OPTIONS: {prepare: true}}));
vi.mock('@app/integration/IntegrationReconciliation', () => ({
	IntegrationReconciliation: class {
		step = vi.fn();
	},
}));
vi.mock('@app/integration/IntegrationContentEvents', () => ({projectIntegrationContent: vi.fn()}));
vi.mock('@app/integration/IntegrationEventJournal', () => ({
	IntegrationEventJournal: class {
		enqueue = testState.enqueue;
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
		execute: async () => ({first: () => (testState.liveSession ? {created_at: new Date()} : undefined)}),
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
});
