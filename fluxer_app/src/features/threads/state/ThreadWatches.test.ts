// SPDX-License-Identifier: AGPL-3.0-or-later

import type {Channel} from '@app/features/channel/models/Channel';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const {send, refresh, connection} = vi.hoisted(() => {
	const send = vi.fn();
	return {
		send,
		refresh: vi.fn(async () => {}),
		connection: {socket: {isConnected: () => true, updateGuildSubscriptions: send}},
	};
});
vi.mock('@app/features/gateway/transport/GatewaySessionPool', () => ({default: {foregroundConnection: connection}}));
vi.mock('@app/features/messaging/commands/MessageCommands', () => ({refreshThreadWatchWindow: refresh}));
vi.mock('@app/features/threads/state/ThreadGuilds', () => ({default: {isActive: () => true}}));
vi.mock('@app/features/platform/utils/DeferUntilModulesLoaded', () => ({
	deferUntilModulesLoaded: (callback: () => void) => callback(),
}));

const {default: watches} = await import('@app/features/threads/state/ThreadWatches');
let releases: Array<() => void> = [];

/** 等待合并到微任务中的浏览集合更新 */
async function flush(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

/** 通过真实引用入口持有一个帖子 */
function retain(id: string, guildId = '1'): () => void {
	const release = watches.retain({id, guildId} as Channel);
	releases.push(release);
	return release;
}

/** 对最后发送的请求模拟服务端逐服务器确认 */
function acknowledge(resync = false): void {
	const request = send.mock.lastCall![0];
	for (const [guildId, options] of Object.entries(request.subscriptions) as Array<
		[string, {thread_watches: Array<string>}]
	>) {
		watches.handleAck({
			nonce: request.thread_watch_nonce,
			ok: true,
			guild_id: guildId,
			thread_ids: options.thread_watches,
			resync_thread_ids: resync ? options.thread_watches : [],
			expires_at: Date.now() + 600_000,
		});
	}
}

describe('帖子浏览订阅', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.spyOn(Math, 'random').mockReturnValue(0.5);
		watches.handleConnectionLost();
		send.mockClear();
		refresh.mockClear();
	});

	afterEach(async () => {
		for (const release of releases) release();
		releases = [];
		watches.handleConnectionLost();
		await flush();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('立即订阅，确认后刷新，四分钟续期不重复拉取历史', async () => {
		retain('20');
		watches.handleConnectionReady();
		await flush();
		expect(send).toHaveBeenCalledTimes(1);
		expect(refresh).not.toHaveBeenCalled();
		acknowledge(true);
		await vi.dynamicImportSettled();
		expect(refresh).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(240_000);
		expect(send).toHaveBeenCalledTimes(2);
		acknowledge();
		expect(refresh).toHaveBeenCalledTimes(1);
	});

	it('共享引用不会误退订，最后释放立即发送空集合', async () => {
		const first = retain('20');
		const second = retain('20');
		watches.handleConnectionReady();
		await flush();
		acknowledge();
		first();
		await flush();
		expect(send).toHaveBeenCalledTimes(1);
		second();
		await flush();
		expect(send.mock.lastCall![0].subscriptions).toEqual({'1': {thread_watches: []}});
	});

	it('跨服务器切换合并旧集合退订与新集合订阅', async () => {
		const release = retain('20', '1');
		watches.handleConnectionReady();
		await flush();
		acknowledge();
		release();
		retain('30', '2');
		await flush();
		expect(send.mock.lastCall![0].subscriptions).toEqual({
			'1': {thread_watches: []},
			'2': {thread_watches: ['30']},
		});
	});

	it('断线停止发送，恢复后旧确认不能确认新订阅', async () => {
		retain('20');
		watches.handleConnectionReady();
		await flush();
		const oldNonce = send.mock.lastCall![0].thread_watch_nonce;
		watches.handleConnectionLost();
		await vi.advanceTimersByTimeAsync(600_000);
		expect(send).toHaveBeenCalledTimes(1);
		watches.handleConnectionReady();
		await flush();
		watches.handleAck({nonce: oldNonce, ok: true, guild_id: '1', thread_ids: ['20']});
		expect(watches.confirmed.has('20')).toBe(false);
		acknowledge();
		expect(watches.confirmed.has('20')).toBe(true);
	});

	it('确认超时明确报错并重试，不能静默宣称实时订阅成功', async () => {
		retain('20');
		watches.handleConnectionReady();
		await flush();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(watches.errors.get('20')).toBe('unavailable');
		expect(watches.confirmed.has('20')).toBe(false);
		expect(send).toHaveBeenCalledTimes(2);
	});

	it('断线期间关闭旧帖子，恢复时立即取消旧服务器的浏览集合', async () => {
		const release = retain('20', '1');
		watches.handleConnectionReady();
		await flush();
		acknowledge();
		watches.handleConnectionLost();
		release();
		retain('30', '2');
		watches.handleConnectionReady();
		await flush();
		expect(send.mock.lastCall![0].subscriptions).toEqual({'1': {thread_watches: []}, '2': {thread_watches: ['30']}});
	});

	it('同一微任务中关闭后重开同帖也使用新的浏览代次', async () => {
		const release = retain('20');
		watches.handleConnectionReady();
		await flush();
		acknowledge();
		await vi.dynamicImportSettled();
		const previous = send.mock.lastCall![0].thread_watch_nonce;
		release();
		retain('20');
		await flush();
		expect(send.mock.lastCall![0].thread_watch_nonce).not.toBe(previous);
		acknowledge();
		await vi.dynamicImportSettled();
		expect(refresh).toHaveBeenCalledTimes(2);
	});

	it('跨服务器超限后持续续期已接受的十帖，关闭旧帖后接纳新帖', async () => {
		const oldIds = Array.from({length: 10}, (_, index) => String(20 + index));
		const closeFirst = retain(oldIds[0], '1');
		for (const [index, id] of oldIds.slice(1).entries()) retain(id, index < 4 ? '1' : '2');
		watches.handleConnectionReady();
		await flush();
		expect(send.mock.lastCall![0].subscriptions).toEqual({
			'1': {thread_watches: oldIds.slice(0, 5)},
			'2': {thread_watches: oldIds.slice(5)},
		});
		acknowledge(true);
		await vi.dynamicImportSettled();
		await flush();
		expect([...watches.confirmed].sort()).toEqual(oldIds);
		expect(refresh).toHaveBeenCalledTimes(10);
		retain('40', '3');
		await flush();
		watches.handleAck({
			nonce: send.mock.lastCall![0].thread_watch_nonce,
			ok: false,
			code: 'THREAD_WATCH_LIMIT_EXCEEDED',
		});
		const acceptedGroups = {
			'1': {thread_watches: oldIds.slice(0, 5)},
			'2': {thread_watches: oldIds.slice(5)},
			'3': {thread_watches: []},
		};
		expect(send.mock.lastCall![0].subscriptions).toEqual(acceptedGroups);
		acknowledge();
		for (let renewal = 0; renewal < 3; renewal += 1) {
			await vi.advanceTimersByTimeAsync(240_000);
			expect(send.mock.lastCall![0].subscriptions).toEqual({
				'1': acceptedGroups['1'],
				'2': acceptedGroups['2'],
			});
			acknowledge();
		}
		expect([...watches.confirmed].sort()).toEqual(oldIds);
		expect(watches.errors.get('40')).toBe('limit');
		expect(refresh).toHaveBeenCalledTimes(10);
		closeFirst();
		await flush();
		expect(send.mock.lastCall![0].subscriptions['3']).toEqual({thread_watches: ['40']});
		acknowledge();
		await vi.dynamicImportSettled();
		expect(watches.confirmed.has('40')).toBe(true);
		expect(watches.errors.has('40')).toBe(false);
		expect(refresh).toHaveBeenCalledTimes(11);
	});

	it('续期一直没有确认时按租约期限失效，迟到的旧确认不能恢复状态', async () => {
		retain('20');
		watches.handleConnectionReady();
		await flush();
		acknowledge();
		await vi.dynamicImportSettled();
		const expiresAt = Date.now() + 600_000;
		await vi.advanceTimersByTimeAsync(600_000);
		expect(watches.confirmed.has('20')).toBe(false);
		expect(watches.errors.get('20')).toBe('expired');
		watches.handleAck({
			nonce: send.mock.lastCall![0].thread_watch_nonce,
			ok: true,
			guild_id: '1',
			thread_ids: ['20'],
			expires_at: expiresAt,
		});
		expect(watches.confirmed.has('20')).toBe(false);
		expect(watches.errors.get('20')).toBe('expired');
		await vi.advanceTimersByTimeAsync(30_000);
		acknowledge();
		await vi.dynamicImportSettled();
		expect(watches.confirmed.has('20')).toBe(true);
		expect(watches.errors.has('20')).toBe(false);
		expect(refresh).toHaveBeenCalledTimes(2);
	});

	it('新续期确认延后到期时间，旧定时器不能使已续期帖子失效', async () => {
		retain('20');
		watches.handleConnectionReady();
		await flush();
		acknowledge();
		await vi.advanceTimersByTimeAsync(240_000);
		acknowledge();
		await vi.advanceTimersByTimeAsync(360_000);
		expect(watches.confirmed.has('20')).toBe(true);
		expect(watches.errors.get('20')).not.toBe('expired');
		await vi.advanceTimersByTimeAsync(240_000);
		expect(watches.confirmed.has('20')).toBe(false);
		expect(watches.errors.get('20')).toBe('expired');
	});

	it('超限回退续期也没有确认时旧帖明确到期，新增帖子仍显示超限', async () => {
		const acceptedIds = Array.from({length: 10}, (_, index) => String(20 + index));
		for (const id of acceptedIds) retain(id);
		watches.handleConnectionReady();
		await flush();
		acknowledge();
		await vi.dynamicImportSettled();
		retain('40');
		await flush();
		watches.handleAck({
			nonce: send.mock.lastCall![0].thread_watch_nonce,
			ok: false,
			code: 'THREAD_WATCH_LIMIT_EXCEEDED',
		});
		await vi.advanceTimersByTimeAsync(600_000);
		expect(watches.confirmed.size).toBe(0);
		for (const id of acceptedIds) expect(watches.errors.get(id)).toBe('expired');
		expect(watches.errors.get('40')).toBe('limit');
		expect(send.mock.lastCall![0].subscriptions).toEqual({'1': {thread_watches: acceptedIds}});
		acknowledge();
		await vi.dynamicImportSettled();
		expect(watches.confirmed.size).toBe(10);
		expect(refresh).toHaveBeenCalledTimes(20);
		expect(watches.errors.get('40')).toBe('limit');
	});

	it('关闭帖子后到期定时器不留下错误或重新发起订阅', async () => {
		const release = retain('20');
		watches.handleConnectionReady();
		await flush();
		acknowledge();
		release();
		await flush();
		acknowledge();
		const sentCount = send.mock.calls.length;
		await vi.advanceTimersByTimeAsync(600_000);
		expect(watches.confirmed.has('20')).toBe(false);
		expect(watches.errors.has('20')).toBe(false);
		expect(send).toHaveBeenCalledTimes(sentCount);
	});
});
