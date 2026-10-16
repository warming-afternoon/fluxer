// SPDX-License-Identifier: AGPL-3.0-or-later

import {randomUUID} from 'node:crypto';
import {
	CassandraMetadataInvalidation,
	type MetadataNotificationConnections,
} from '@app/api/database/CassandraMetadataInvalidation';
import {afterEach, describe, expect, it, vi} from 'vitest';

const active: Array<CassandraMetadataInvalidation> = [];
afterEach(async () => {
	await Promise.all(active.splice(0).map((service) => service.shutdown()));
	vi.useRealTimers();
});

/** 构造不联网的发布订阅传输，显式控制断开和故障。 */
function setup() {
	let message!: (value: string) => void;
	let state!: (ready: boolean) => void;
	const publish = vi.fn(async (_channel: string, _value: string): Promise<void> => undefined);
	const connect = vi.fn(async (_channel: string, onMessage: typeof message, onState: typeof state) => {
		message = onMessage;
		state = onState;
		state(true);
	});
	const connections: MetadataNotificationConnections = {publish, connect, close: vi.fn()};
	const apply = vi.fn();
	const service = new CassandraMetadataInvalidation(apply, {
		scope: 'deployment/keyspace',
		kv: {url: 'redis://127.0.0.1'},
		connections,
	});
	active.push(service);
	service.start();
	return {
		service,
		apply,
		publish,
		connect,
		connections,
		message: (value: string) => message(value),
		state: (ready: boolean) => state(ready),
	};
}

describe('best effort metadata Pub/Sub', () => {
	it('coalesces IDs, splits batches and publishes no entity contents', async () => {
		const {service, publish} = setup();
		service.enqueue([
			{entity: 'channel', ids: Array.from({length: 205}, (_, index) => String(index + 1))},
			{entity: 'channel', ids: ['1']},
		]);
		await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(3));
		const notices = publish.mock.calls.map((call) => JSON.parse(call[1]));
		expect(notices.map((notice) => notice.ids.length)).toEqual([100, 100, 5]);
		expect(new Set(notices.flatMap((notice) => notice.ids)).size).toBe(205);
		expect(Object.keys(notices[0]).sort()).toEqual(['entity', 'eventId', 'ids', 'origin', 'version']);
		expect(service.renderMetrics()).toContain('notifications_coalesced_total 1');
	});

	it('promotes queue overflow to a category clear and keeps only one publish in flight', async () => {
		const {service, publish} = setup();
		const gate = Promise.withResolvers<void>();
		publish.mockReturnValueOnce(gate.promise);
		service.enqueue([{entity: 'channel', ids: ['1']}]);
		await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
		service.enqueue([{entity: 'channel', ids: Array.from({length: 2000}, (_, index) => String(index + 2))}]);
		expect(publish).toHaveBeenCalledTimes(1);
		expect(service.renderMetrics()).toContain('notifications_pending_keys 0');
		expect(service.renderMetrics()).toContain('notifications_overflow_total 1');
		gate.resolve();
		await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(2));
		expect(JSON.parse(publish.mock.calls[1]![1])).toMatchObject({entity: 'channel', ids: null});
	});

	it('drops failed publications without retry and continues subsequent notifications', async () => {
		const {service, publish} = setup();
		publish.mockRejectedValueOnce(new Error('offline'));
		service.enqueue([{entity: 'guild', ids: ['1']}]);
		await vi.waitFor(() => expect(service.renderMetrics()).toContain('notifications_failures_total 1'));
		expect(publish).toHaveBeenCalledTimes(1);
		service.enqueue([{entity: 'guild', ids: ['2']}]);
		await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(2));
	});

	it('handles precise and duplicate notices and clears local state on malformed notices or reconnect', () => {
		const {apply, message, state} = setup();
		apply.mockClear();
		const notice = JSON.stringify({
			version: 1,
			eventId: randomUUID(),
			origin: randomUUID(),
			entity: 'channel',
			ids: ['1'],
		});
		message(notice);
		message(notice);
		expect(apply.mock.calls).toEqual([[{entity: 'channel', ids: ['1']}], [{entity: 'channel', ids: ['1']}]]);
		message('bad json');
		expect(apply.mock.calls.slice(-2)).toEqual([[{entity: 'channel', ids: null}], [{entity: 'guild', ids: null}]]);
		apply.mockClear();
		state(false);
		state(true);
		expect(apply).toHaveBeenCalledTimes(4);
	});

	it('does not reject startup and retries initial subscription failure with bounded backoff', async () => {
		vi.useFakeTimers();
		const {service, connect} = setup();
		await Promise.resolve();
		connect.mockRejectedValue(new Error('offline'));
		// 使用另一实例触发初次连接失败。
		const other = new CassandraMetadataInvalidation(vi.fn(), {
			scope: 'other',
			kv: {url: 'redis://127.0.0.1'},
			connections: {publish: vi.fn(), connect, close: vi.fn()},
		});
		active.push(other);
		expect(() => other.start()).not.toThrow();
		await vi.advanceTimersByTimeAsync(31_000);
		expect(connect.mock.calls.length).toBeLessThan(15);
		expect(other.renderMetrics()).toContain('notifications_subscribed 0');
		expect(service.renderMetrics()).not.toContain('journal');
	});

	it('bounds shutdown even when the active publisher never completes', async () => {
		vi.useFakeTimers();
		const {service, publish, connections} = setup();
		publish.mockReturnValue(new Promise(() => {}));
		service.enqueue([{entity: 'channel', ids: ['1']}]);
		await vi.advanceTimersByTimeAsync(0);
		const stop = service.shutdown();
		await vi.advanceTimersByTimeAsync(250);
		await stop;
		expect(connections.close).toHaveBeenCalled();
		service.enqueue([{entity: 'channel', ids: ['2']}]);
		expect(publish).toHaveBeenCalledTimes(1);
	});
});
