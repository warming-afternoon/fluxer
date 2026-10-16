// SPDX-License-Identifier: AGPL-3.0-or-later

// Offline transport fixture only. No server/listener/network; NOT a performance test.
import fs from 'node:fs';
import {loadForumLoadFixture} from './ForumLoadFixture.mjs';

const args = process.argv.slice(2),
	file = args[args.indexOf('--fixture') + 1];
if (process.env.BENCH_TEST_CREATE_STOP_FILE)
	setTimeout(() => fs.writeFileSync(args[args.indexOf('--stop-file') + 1], 'ignored contents'), 100);
const stepIndex = args.indexOf('--online-steps');
const steps = stepIndex >= 0 ? args[stepIndex + 1] : '4';
const fixture = loadForumLoadFixture(file, Number(steps.split(',').at(-1)));
const memberIds = (thread) => thread.memberIndexes.map((index) => fixture.accounts[index].id);
const users = new Map(fixture.accounts.map((a) => [a.email || a.login, a]));
const sockets = new Map();
class MockSocket extends EventTarget {
	static OPEN = 1;
	readyState = 1;
	seq = 0;
	constructor() {
		super();
		setImmediate(() => {
			this.dispatchEvent(new Event('open'));
			this.emit({op: 10, d: {heartbeat_interval: 1000}});
		});
	}
	emit(data) {
		this.dispatchEvent(new MessageEvent('message', {data: JSON.stringify(data)}));
	}
	send(raw) {
		const p = JSON.parse(raw);
		if (p.op === 1) this.emit({op: 11});
		if (p.op === 2) {
			this.id = p.d.token;
			sockets.set(this.id, this);
			this.emit({op: 0, t: 'READY', s: ++this.seq, d: {}});
		}
		if (
			p.op === 14 &&
			p.d.subscriptions[fixture.guildId]?.active !== false &&
			!process.env.BENCH_TEST_SUBSCRIPTION_HANG
		) {
			const ts = fixture.threads.filter((t) => memberIds(t).includes(this.id)).map((t) => ({id: t.id}));
			const partial =
				process.env.BENCH_TEST_PARTIAL_SYNC ||
				process.env.BENCH_TEST_INCREMENTAL_SYNC ||
				process.env.BENCH_TEST_CLOSE_PARTIAL;
			this.emit({
				op: 0,
				t: 'THREAD_LIST_SYNC',
				s: ++this.seq,
				d: {guild_id: fixture.guildId, threads: process.env.BENCH_TEST_EMPTY_SYNC ? [] : partial ? ts.slice(0, 1) : ts},
			});
			if (process.env.BENCH_TEST_INCREMENTAL_SYNC)
				setTimeout(() => {
					for (const t of ts.slice(1))
						this.emit({op: 0, t: 'THREAD_CREATE', s: ++this.seq, d: {guild_id: fixture.guildId, ...t}});
				}, 20);
			if (process.env.BENCH_TEST_CLOSE_PARTIAL)
				setTimeout(() => {
					if (this.readyState !== 3) this.close(1006, 'mock server close');
				}, 20);
		}
	}
	close(code = 1000, reason = '') {
		this.readyState = 3;
		const e = new Event('close');
		Object.defineProperties(e, {code: {value: code}, reason: {value: reason}});
		this.dispatchEvent(e);
	}
}
globalThis.WebSocket = MockSocket;
let n = 0;
globalThis.fetch = async (url, options) => {
	const path = new URL(url).pathname,
		body = JSON.parse(options.body);
	if (path.endsWith('/auth/login'))
		return new Response(JSON.stringify({token: users.get(body.email || body.login).id}), {status: 200});
	if (path.endsWith('/read-states/ack'))
		return new Response(
			JSON.stringify({read_states: body.read_states.map((e) => ({id: e.channel_id, last_message_id: e.message_id}))}),
			{status: 200},
		);
	if (path.endsWith('/ack')) {
		if (process.env.BENCH_TEST_ACK_DELAY_MS)
			await new Promise((resolve) => setTimeout(resolve, Number(process.env.BENCH_TEST_ACK_DELAY_MS)));
		return process.env.BENCH_TEST_ACK_FAILURE ? new Response('{}', {status: 503}) : new Response(null, {status: 204});
	}
	const channel = path.match(/\/channels\/(\d+)\/messages$/)?.[1];
	if (channel) {
		if ([...body.content].length !== 20 || Buffer.byteLength(body.content, 'utf8') !== 60)
			throw Error('Benchmark message must contain exactly 20 Chinese characters / 60 UTF-8 bytes');
		if (process.env.BENCH_TEST_OLD_SEQUENCE) {
			const old = {id: 'old-message', channel_id: channel, content: '社区压测消息用于验证送达〇〇〇〇〇〇〇〇'};
			for (const ws of sockets.values()) ws.emit({op: 0, t: 'MESSAGE_CREATE', s: ++ws.seq, d: old});
		}
		if (process.env.BENCH_TEST_SEND_STATUS === '429')
			return new Response(JSON.stringify({code: 'MOCK_RATE_LIMIT'}), {status: 429});
		const thread = fixture.threads.find((t) => t.id === channel),
			message = {id: String(++n), channel_id: channel, content: body.content};
		for (const [index, id] of memberIds(thread).entries()) {
			const ws = sockets.get(id);
			if (ws && !(process.env.BENCH_TEST_MISSING && index === 0)) {
				ws.emit({op: 0, t: 'MESSAGE_CREATE', s: ++ws.seq, d: message});
				if (process.env.BENCH_TEST_LATE_DUPLICATE)
					setTimeout(() => ws.emit({op: 0, t: 'MESSAGE_CREATE', s: ++ws.seq, d: message}), 50);
				if (process.env.BENCH_TEST_DUPLICATE) ws.emit({op: 0, t: 'MESSAGE_CREATE', s: ++ws.seq, d: message});
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
		return new Response(JSON.stringify(message), {status: 200});
	}
	throw Error('Unexpected mock path ' + path);
};
