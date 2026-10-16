// SPDX-License-Identifier: AGPL-3.0-or-later

// Real HTTP + WebSocket forum load. Never targets a non-loopback host without --allow-remote.
import fs from 'node:fs';
import os from 'node:os';
import {monitorEventLoopDelay, performance} from 'node:perf_hooks';
import {setTimeout as sleep} from 'node:timers/promises';
import {loadForumLoadFixture} from './ForumLoadFixture.mjs';

const argv = process.argv.slice(2);
const opt = Object.fromEntries(
	argv
		.map((v, i) =>
			v.startsWith('--') ? [v.slice(2), argv[i + 1]?.startsWith('--') ? true : (argv[i + 1] ?? true)] : [],
		)
		.filter((x) => x.length),
);
if (!opt.fixture || !opt.out) {
	console.log(
		'node forum_load.mjs --fixture compact.private.json --out result-dir --online 4000 --rate 20 --seconds 10 [--burst 1000 --concurrency 16] [--connect-concurrency 8 --stable-seconds 10 --drain-seconds 120 --ack-concurrency 128 --max-ack-backlog 100000]',
	);
	process.exit(opt.help ? 0 : 2);
}
const onlineSteps = String(opt['online-steps'] || opt.online || 2500)
	.split(',')
	.map(Number);
if (onlineSteps.some((n, i) => !Number.isInteger(n) || n < 2 || (i && n <= onlineSteps[i - 1])))
	throw Error('Online steps must increase');
const fixture = loadForumLoadFixture(opt.fixture, onlineSteps.at(-1));
const api = (opt.api || fixture.apiBase).replace(/\/$/, '');
const gateway = opt.gateway || fixture.gatewayUrl;
for (const url of [api, gateway])
	if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname) && !opt['allow-remote'])
		throw Error('Refusing non-loopback load target');
let onlineTarget = onlineSteps[0];
const rate = Number(opt.rate || 20),
	seconds = Number(opt.seconds || 10);
const burst = Number(opt.burst || 0),
	concurrency = Number(opt.concurrency || 16);
const plan = opt.plan
	? JSON.parse(fs.readFileSync(opt.plan, 'utf8'))
	: [{name: 'single', rate, seconds, burst, concurrency}];
const sequenceBase = Number(opt['sequence-base'] ?? 0),
	plannedSequenceCount = plan.reduce((n, p) => n + (p.burst || Math.floor(p.rate * p.seconds)), 0) * onlineSteps.length;
if (!Number.isSafeInteger(sequenceBase) || sequenceBase < 0 || sequenceBase + plannedSequenceCount > 100000000)
	throw Error('sequence-base and workload must fit eight Chinese digits (0..99999999)');
let ackConcurrency = Number(opt['ack-concurrency'] || 128),
	maxAckBacklog = Number(opt['max-ack-backlog'] || 100000);
const drainMs = Number(opt['drain-seconds'] || 120) * 1000;
const loginPhaseTimeoutSeconds = Number(opt['login-phase-timeout-seconds'] || 1800);
if (!Number.isFinite(loginPhaseTimeoutSeconds) || loginPhaseTimeoutSeconds <= 0)
	throw Error('Login phase deadline must be positive seconds');
const loginFailFast = opt['login-fail-fast'] !== 'false';
let operatorCancelled = false,
	operatorCancelReason = null;
let loginPhaseDeadlineExceeded = false,
	loginPhaseStopped = false,
	loginPhaseTimer = null,
	readyOnlineAtLoginDeadline = null;
let accounts = fixture.accounts.slice(0, onlineSteps.at(-1));
if (accounts.length !== onlineSteps.at(-1)) throw Error('Fixture does not have enough accounts');
if (new Set(accounts.map((a) => a.id)).size !== accounts.length) throw Error('Fixture contains duplicate account IDs');
const allAccounts = accounts;
accounts = [];
fs.mkdirSync(opt.out, {recursive: true, mode: 0o700});
const streams = Object.fromEntries(
	['events', 'resources', 'messages'].map((n) => [
		n,
		fs.createWriteStream(`${opt.out}/${n}.jsonl`, {flags: 'wx', mode: 0o600}),
	]),
);
let activeStage = null;
const stages = [];
const tiers = [];
let offset = 0;
let phase = 'setup',
	abortReason = null,
	shuttingDown = false,
	activeSend = 0,
	ackActive = 0,
	ackQueued = 0,
	lastDelivery = 0;
const runId = Date.now().toString(36),
	prefix = '社区压测消息用于验证送达',
	digits = '〇一二三四五六七八九';
/** 生成固定长度中文消息，沿用基线内容编码。 */
function messageContent(i) {
	if (!Number.isInteger(i) || i < 0 || i >= 100000000) throw Error('Sequence exceeds eight-character Chinese encoding');
	return (
		prefix +
		String(i)
			.padStart(8, '0')
			.split('')
			.map((d) => digits[Number(d)])
			.join('')
	);
}
const activeThreadIds = new Set(
	fixture.threads.filter((t) => t.active !== false && !t.archived).map((t) => String(t.id)),
);
if (allAccounts.some((a) => !Array.isArray(a.joinedThreadIds)))
	throw Error('Fixture accounts must include joinedThreadIds for readiness verification');
// 完成记录用位图保留整轮重复投递检查，避免集合随消息数量增长。
const states = new Map(),
	pending = new Map(),
	completed = new Uint8Array(Math.ceil(plannedSequenceCount / 8));
const totals = {
	loginAttempted: 0,
	loginUnattempted: onlineTarget,
	connectionsAttempted: 0,
	connectionCancelledBeforeReady: 0,
	connectSkippedAfterLoginStop: 0,
	connectionTimeoutCloses: 0,
	connectionsClosedByHarness: 0,
	loginSuccess: 0,
	loginFailed: 0,
	connectionsReady: 0,
	connectionFailed: 0,
	unexpectedDisconnects: 0,
	offered: 0,
	submitted: 0,
	sendSuccess: 0,
	sendFailed: 0,
	send429: 0,
	expectedDeliveries: 0,
	actualUniqueDeliveries: 0,
	duplicates: 0,
	unauthorizedDeliveries: 0,
	lateDeliveries: 0,
	ackSuccess: 0,
	ackFailed: 0,
	ack429: 0,
	ackQueueRejected: 0,
	ackEvents: 0,
	missingDeliveries: 0,
	missingAcks: 0,
};
const httpStatuses = {send: {}, ack: {}, login: {}};
const hist = {};
/** 保留原始延迟直方图口径，不减少样本。 */
function record(name, ms) {
	if (!Number.isFinite(ms)) return;
	const h = (hist[name] ??= {n: 0, bins: new Map(), max: 0});
	const k = Math.ceil(ms * 10) / 10;
	h.bins.set(k, (h.bins.get(k) || 0) + 1);
	h.n++;
	h.max = Math.max(h.max, ms);
}
/** 按原有直方图计算分位数。 */
function percentiles() {
	return Object.fromEntries(
		Object.entries(hist).map(([k, h]) => {
			const bins = [...h.bins].sort((a, b) => a[0] - b[0]);
			const q = (p) => {
				let sum = 0;
				for (const [v, n] of bins) {
					sum += n;
					if (sum >= Math.ceil(p * h.n)) return v;
				}
				return null;
			};
			return [
				k,
				{count: h.n, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: h.max, unit: 'ms', rounding: 'ceil 0.1 ms'},
			];
		}),
	);
}
/** 流式记录结果，磁盘积压超限时显式停止。 */
function write(stream, obj) {
	if (
		!streams[stream].write(
			JSON.stringify({utc: new Date().toISOString(), phase, stage: activeStage, targetOnline: onlineTarget, ...obj}) +
				'\n',
		) &&
		streams[stream].writableLength > 64 * 1024 * 1024
	)
		abortReason ??= 'Output disk backpressure exceeded 64 MiB';
}
function setPhase(p) {
	phase = p;
	write('events', {type: 'phase', name: p, monotonicMs: performance.now()});
}
function fail(reason) {
	abortReason ??= reason;
	write('events', {type: 'abort', reason});
}
function stopLogin(reason) {
	if (loginPhaseStopped) return;
	loginPhaseStopped = true;
	fail(reason);
	for (const s of states.values()) s.cancelConnect?.();
}
function checkStopFile() {
	if (operatorCancelled || !opt['stop-file'] || !fs.existsSync(opt['stop-file'])) return;
	operatorCancelled = true;
	operatorCancelReason = 'Operator stop file observed';
	write('events', {type: 'operator_cancelled', reason: operatorCancelReason});
	if (phase === 'login_and_subscription' || phase === 'setup') stopLogin(operatorCancelReason);
	else fail(operatorCancelReason);
}
async function pool(items, n, fn, shouldStop = () => false) {
	let i = 0;
	await Promise.all(
		Array.from({length: Math.min(n, items.length)}, async () => {
			while (i < items.length && !shouldStop()) {
				const j = i++;
				await fn(items[j], j);
			}
		}),
	);
}
async function request(path, token, body, kind) {
	const start = performance.now();
	let status = 0,
		data = null,
		error = null;
	try {
		const res = await fetch(api + path, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Fluxer-Features': 'channel_threads',
				'X-Loadtest-Stage': activeStage || phase,
				...(token ? {Authorization: token} : {}),
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(Number(opt['http-timeout-ms'] || 30000)),
		});
		status = res.status;
		const text = await res.text();
		try {
			data = text ? JSON.parse(text) : null;
		} catch {
			data = null;
		}
	} catch (e) {
		error = e.name + ': ' + e.message;
	}
	if (kind) {
		httpStatuses[kind][status] = (httpStatuses[kind][status] || 0) + 1;
		record(`${kind}HttpMs`, performance.now() - start);
	}
	return {status, data, error, ms: performance.now() - start};
}
const eld = monitorEventLoopDelay({resolution: 20});
eld.enable();
let previousCpu = process.cpuUsage(),
	previousSample = performance.now();
function read(path) {
	try {
		return fs.readFileSync(path, 'utf8').trim();
	} catch {
		return null;
	}
}
const sample = setInterval(() => {
	checkStopFile();
	const now = performance.now(),
		cpu = process.cpuUsage(),
		delta = now - previousSample;
	write('resources', {
		online: [...states.values()].filter((s) => s.open && s.ready && s.synced).length,
		activeSend,
		ackActive,
		ackQueued,
		pendingMessages: pending.size,
		generator: {
			pid: process.pid,
			memory: process.memoryUsage(),
			cpuPercent: (cpu.user - previousCpu.user + (cpu.system - previousCpu.system)) / delta / 10,
			eventLoopP50Ms: eld.percentile(50) / 1e6,
			eventLoopP95Ms: eld.percentile(95) / 1e6,
			eventLoopP99Ms: eld.percentile(99) / 1e6,
			eventLoopMaxMs: eld.max / 1e6,
		},
		host: {load: os.loadavg(), freeMemory: os.freemem()},
		cgroup: {
			memoryCurrent: read('/sys/fs/cgroup/memory.current'),
			memoryMax: read('/sys/fs/cgroup/memory.max'),
			memoryEvents: read('/sys/fs/cgroup/memory.events'),
			cpuStat: read('/sys/fs/cgroup/cpu.stat'),
			cpuPressure: read('/sys/fs/cgroup/cpu.pressure'),
			memoryPressure: read('/sys/fs/cgroup/memory.pressure'),
		},
	});
	previousCpu = cpu;
	previousSample = now;
	eld.reset();
}, 1000);
const ackReady = [];
/** 待确认任务只保留消息ID和共享状态，逐条确认语义不变。 */
function enqueueAck(s, m, msg) {
	if (ackQueued >= maxAckBacklog) {
		totals.ackQueueRejected++;
		m.ackRejected.add(s.account.index);
		fail('Bounded ACK backlog exceeded; workload cannot be sustained');
		return;
	}
	s.ackQueue.push({m, messageId: msg.id, enqueued: performance.now()});
	ackQueued++;
	if (!s.ackBusy) {
		s.ackBusy = true;
		ackReady.push(s);
	}
	pumpAck();
}
function pumpAck() {
	while (ackActive < ackConcurrency && ackReady.length) {
		const s = ackReady.shift(),
			job = s.ackQueue.shift();
		ackQueued--;
		ackActive++;
		(async () => {
			record('ackQueueWaitMs', performance.now() - job.enqueued);
			const r = await request(
				`/channels/${job.m.thread.id}/messages/${job.messageId}/ack`,
				s.token,
				{mention_count: 0},
				'ack',
			);
			const id = s.account.index;
			if (r.status === 204) {
				totals.ackSuccess++;
				job.m.acked.add(id);
				record('endToEndAckMs', performance.now() - job.m.started);
			} else {
				totals.ackFailed++;
				job.m.ackFailed.add(id);
				if (r.status === 429) totals.ack429++;
				write('events', {
					type: 'ack_error',
					sequence: job.m.sequence,
					userId: s.account.id,
					status: r.status,
					error: r.error,
				});
			}
			job.m.ackFinished++;
			maybeFinish(job.m);
		})()
			.catch((e) => fail('ACK worker ' + e.message))
			.finally(() => {
				ackActive--;
				if (s.ackQueue.length) ackReady.push(s);
				else s.ackBusy = false;
				if (!shuttingDown) pumpAck();
			});
	}
}
function receive(s, d) {
	const content = d.content ?? '';
	if (!content.startsWith(prefix)) return;
	const suffix = content.slice(prefix.length);
	if (suffix.length !== 8 || [...suffix].some((c) => !digits.includes(c))) return;
	const absoluteSequence = Number([...suffix].map((c) => digits.indexOf(c)).join(''));
	const id = absoluteSequence - sequenceBase;
	if (id < 0 || id >= plannedSequenceCount) {
		write('events', {type: 'outside_run_sequence', absoluteSequence, userId: s.account.id, messageId: d.id});
		return;
	}
	const m = pending.get(id);
	if (!m) {
		totals.lateDeliveries++;
		if ((completed[id >>> 3] & (1 << (id & 7))) !== 0) totals.duplicates++;
		write('events', {
			type: (completed[id >>> 3] & (1 << (id & 7))) !== 0 ? 'post_completion_duplicate' : 'unmatched_delivery',
			sequence: id,
			userId: s.account.id,
			messageId: d.id,
		});
		return;
	}
	const user = s.account.index;
	if (m.received.has(user)) {
		totals.duplicates++;
		m.duplicates++;
		return;
	}
	m.received.add(user);
	lastDelivery = performance.now();
	if (!m.expected.has(user)) {
		totals.unauthorizedDeliveries++;
		m.unauthorized.add(user);
		fail('Unauthorized ordinary forum message delivered');
		return;
	}
	totals.actualUniqueDeliveries++;
	m.deliveryMinMs = Math.min(m.deliveryMinMs, lastDelivery - m.started);
	m.deliveryMaxMs = Math.max(m.deliveryMaxMs, lastDelivery - m.started);
	record('deliveryFromSubmitMs', lastDelivery - m.started);
	record('deliveryFromScheduledMs', lastDelivery - m.scheduled);
	enqueueAck(s, m, d);
}
function maybeFinish(m) {
	if (
		m.httpDone &&
		m.success &&
		m.received.size - m.unauthorized.size === m.expected.size &&
		m.ackFinished === m.expected.size
	)
		finish(m, false);
}
/** 结束时恢复报告中的用户ID，运行中集合使用整数。 */
function finish(m, timedOut) {
	if (!pending.has(m.sequence)) return;
	const missing = [...m.expected].filter((id) => !m.received.has(id)),
		missingAck = [...m.expected].filter((id) => !m.acked.has(id));
	if (m.success) {
		totals.missingDeliveries += missing.length;
		totals.missingAcks += missingAck.length;
	}
	write('messages', {
		sequence: m.sequence,
		messageId: m.messageId ?? null,
		channelId: m.thread.id,
		senderId: m.sender.id,
		contentCharacters: m.contentCharacters,
		contentUtf8Bytes: m.contentUtf8Bytes,
		requestJsonUtf8Bytes: m.requestJsonUtf8Bytes,
		scheduledMs: m.scheduled,
		submitMs: m.started,
		httpMs: m.httpMs,
		httpStatus: m.httpStatus,
		success: m.success,
		timedOut,
		expectedRecipientIds: [...m.expected].map((index) => allAccounts[index].id),
		actualRecipientIds: [...m.received].map((index) => allAccounts[index].id),
		unauthorizedRecipientIds: [...m.unauthorized].map((index) => allAccounts[index].id),
		missingRecipientIds: m.success ? missing.map((index) => allAccounts[index].id) : [],
		ackSuccessIds: [...m.acked].map((index) => allAccounts[index].id),
		ackFailedIds: [...m.ackFailed].map((index) => allAccounts[index].id),
		ackRejectedIds: [...m.ackRejected].map((index) => allAccounts[index].id),
		missingAckIds: m.success ? missingAck.map((index) => allAccounts[index].id) : [],
		duplicates: m.duplicates,
		deliveryMinMs: m.received.size ? m.deliveryMinMs : null,
		deliveryMaxMs: m.received.size ? m.deliveryMaxMs : null,
		completeMs: performance.now() - m.started,
	});
	completed[m.sequence >>> 3] |= 1 << (m.sequence & 7);
	pending.delete(m.sequence);
}
async function connect(account) {
	totals.loginAttempted++;
	totals.loginUnattempted = onlineTarget - totals.loginAttempted;
	const s = {
		startedMs: performance.now(),
		authDoneMs: null,
		openMs: null,
		readyMs: null,
		account,
		token: account.token,
		open: false,
		ready: false,
		synced: false,
		seenThreadIds: new Set(),
		requiredThreadIds: new Set(account.joinedThreadIds.map(String).filter((id) => activeThreadIds.has(id))),
		seq: null,
		heartbeat: null,
		heartbeatAcks: 0,
		ackQueue: [],
		ackBusy: false,
		ws: null,
	};
	states.set(account.index, s);
	if (!s.token) {
		const r = await request(
			'/auth/login',
			null,
			{...(account.email ? {email: account.email} : {login: account.login}), password: account.password},
			'login',
		);
		if (r.status !== 200 || !r.data?.token) {
			totals.loginFailed++;
			write('events', {
				type: 'login_failed',
				userId: account.id,
				status: r.status,
				error: r.error,
				responseCode: r.data?.code,
			});
			if (loginFailFast) stopLogin('Login failed; full target readiness is impossible in this run');
			return;
		}
		s.token = r.data.token;
		s.authDoneMs = performance.now();
	}
	totals.loginSuccess++;
	if (loginPhaseStopped) {
		totals.connectSkippedAfterLoginStop++;
		return;
	}
	totals.connectionsAttempted++;
	await new Promise((resolve) => {
		let settled = false;
		const done = () => {
			if (!settled) {
				settled = true;
				clearTimeout(timeout);
				resolve();
			}
		};
		const timeout = setTimeout(
			() => {
				totals.connectionFailed++;
				write('events', {
					type: 'subscription_timeout',
					userId: account.id,
					ready: s.ready,
					synced: s.synced,
					requiredThreads: s.requiredThreadIds.size,
					seenThreads: s.seenThreadIds.size,
					missingThreadIds: [...s.requiredThreadIds].filter((id) => !s.seenThreadIds.has(id)),
				});
				s.cancelledByHarness = true;
				totals.connectionTimeoutCloses++;
				totals.connectionsClosedByHarness++;
				clearInterval(s.heartbeat);
				s.ws?.close();
				done();
				if (loginFailFast) stopLogin('Subscription timeout; full target readiness is impossible in this run');
			},
			Number(opt['connect-timeout-ms'] || 180000),
		);
		const ws = (s.ws = new WebSocket(gateway));
		s.cancelConnect = () => {
			if (s.cancelledByHarness) return;
			if (ws.readyState === 3) {
				done();
				return;
			}
			s.cancelledByHarness = true;
			totals.connectionsClosedByHarness++;
			if (!s.ready || !s.synced) totals.connectionCancelledBeforeReady++;
			clearInterval(s.heartbeat);
			try {
				ws.close(1000, 'benchmark login cancelled');
			} catch {}
			done();
		};
		ws.addEventListener('open', () => {
			s.open = true;
			s.openMs = performance.now();
		});
		ws.addEventListener('message', (event) => {
			try {
				if (typeof event.data !== 'string')
					throw Error('Expected uncompressed JSON websocket; remove compress query parameter');
				const p = JSON.parse(event.data);
				if (p.s != null) s.seq = p.s;
				if (p.op === 10) {
					const beat = () => {
						if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({op: 1, d: s.seq}));
					};
					s.heartbeat = setInterval(beat, p.d.heartbeat_interval);
					beat();
					ws.send(
						JSON.stringify({
							op: 2,
							d: {
								token: s.token,
								flags: 4,
								properties: {os: 'linux', browser: 'fluxer-load', device: 'fluxer-load'},
								initial_guild_id: fixture.guildId,
								presence: {status: 'online', afk: false, since: 0},
							},
						}),
					);
				} else if (p.op === 11) {
					s.heartbeatAcks++;
				} else if (p.op === 1) {
					ws.send(JSON.stringify({op: 1, d: s.seq}));
				} else if (p.op === 7 || p.op === 9) {
					write('events', {type: 'gateway_reconnect_or_invalid', userId: account.id, opcode: p.op});
					fail('Gateway requested reconnect or invalid session; no silent retry');
				} else if (p.op === 0) {
					if (p.t === 'READY') {
						s.ready = true;
						s.readyMs = performance.now();
						ws.send(
							JSON.stringify({
								op: 14,
								d: {subscriptions: {[fixture.guildId]: {active: true, threads: true, sync: true}}},
							}),
						);
					}
					if (
						['THREAD_LIST_SYNC', 'THREAD_CREATE', 'THREAD_DELETE'].includes(p.t) &&
						String(p.d.guild_id) === String(fixture.guildId) &&
						!s.synced
					) {
						if (p.t === 'THREAD_DELETE') s.seenThreadIds.delete(String(p.d.id));
						else
							for (const t of p.t === 'THREAD_LIST_SYNC' ? (p.d.threads ?? []) : [p.d])
								s.seenThreadIds.add(String(t.id));
						s.synced = [...s.requiredThreadIds].every((id) => s.seenThreadIds.has(id));
						write('events', {
							type: 'thread_readiness',
							userId: account.id,
							event: p.t,
							requiredThreads: s.requiredThreadIds.size,
							syncedRequiredThreads: [...s.requiredThreadIds].filter((id) => s.seenThreadIds.has(id)).length,
							seenThreads: s.seenThreadIds.size,
							complete: s.synced,
						});
						if (s.ready && s.synced) {
							const end = performance.now();
							const timings = {
								authToOpenMs: s.openMs - (s.authDoneMs ?? s.startedMs),
								openToReadyMs: s.readyMs - s.openMs,
								readyToDirectoryMs: end - s.readyMs,
								connectionReadyMs: end - s.startedMs,
							};
							for (const [name, value] of Object.entries(timings)) record(name, value);
							write('events', {type: 'connection_timing', userId: account.id, ...timings});
							totals.connectionsReady++;
							done();
						}
					}
					if (p.t === 'MESSAGE_CREATE') receive(s, p.d);
					if (p.t === 'MESSAGE_ACK') totals.ackEvents++;
				}
			} catch (e) {
				fail('WebSocket processing: ' + e.message);
			}
		});
		ws.addEventListener('error', () => {
			write('events', {type: 'websocket_error', userId: account.id});
		});
		ws.addEventListener('close', (e) => {
			s.open = false;
			clearInterval(s.heartbeat);
			if (!shuttingDown && !s.cancelledByHarness) {
				totals.unexpectedDisconnects++;
				write('events', {type: 'unexpected_close', userId: account.id, code: e.code, reason: e.reason});
				if (phase === 'messaging' || phase === 'delivery_ack_drain')
					fail('Unexpected disconnect during measured workload');
				if (phase === 'login_and_subscription' && loginFailFast)
					stopLogin('Unexpected close during login; full target readiness is impossible in this run');
			}
			done();
		});
	});
}
let measuredStart = 0,
	submissionEnd = 0,
	completeEnd = 0,
	summary,
	drainIncomplete = false;
try {
	for (const target of onlineSteps) {
		onlineTarget = target;
		const newAccounts = allAccounts.slice(accounts.length, target);
		accounts = allAccounts.slice(0, target);
		const stageStart = stages.length;
		const tierStartedAt = new Date().toISOString();
		for (const name of Object.keys(hist)) delete hist[name];
		setPhase('login_and_subscription');
		checkStopFile();
		loginPhaseTimer = setTimeout(() => {
			loginPhaseDeadlineExceeded = true;
			readyOnlineAtLoginDeadline = [...states.values()].filter((s) => s.open && s.ready && s.synced).length;
			stopLogin('Login/subscription phase deadline exceeded; target online count not reached');
		}, loginPhaseTimeoutSeconds * 1000);
		await pool(newAccounts, Number(opt['connect-concurrency'] || 8), connect, () => loginPhaseStopped);
		clearTimeout(loginPhaseTimer);
		loginPhaseTimer = null;
		const online = () => [...states.values()].filter((s) => s.open && s.ready && s.synced).length;
		if (
			abortReason ||
			online() !== onlineTarget ||
			totals.loginFailed ||
			totals.connectionFailed ||
			totals.unexpectedDisconnects
		)
			throw Error(`Readiness barrier failed: ${online()}/${onlineTarget} online`);
		write('events', {
			type: 'subscription_barrier',
			accounts: [...states.values()].map((s) => ({
				userId: s.account.id,
				expectedActiveJoined: s.requiredThreadIds.size,
				syncedCount: [...s.requiredThreadIds].filter((id) => s.seenThreadIds.has(id)).length,
			})),
		});
		setPhase('stable');
		await sleep(Number(opt['stable-seconds'] || 10) * 1000);
		if (online() !== onlineTarget || abortReason || [...states.values()].some((s) => s.heartbeatAcks < 1))
			throw Error(abortReason || 'Stable online/heartbeat barrier failed');
		const candidates = fixture.threads
			.filter((t) => t.active !== false && !t.archived)
			.map((t) => ({...t, onlineMembers: t.memberIndexes.filter((index) => index < onlineTarget)}))
			.filter((t) => t.onlineMembers.length > 1);
		if (!candidates.length) throw Error('No thread has at least two online members');
		const loginLatencies = percentiles();
		for (const workload of plan) {
			const rate = workload.rate || 20,
				seconds = workload.seconds || 20,
				burst = workload.burst || 0,
				concurrency = workload.concurrency || 16;
			ackConcurrency = Number(workload.ackConcurrency || opt['ack-concurrency'] || 128);
			activeStage = `online${onlineTarget}-${workload.name}`;
			const startedAt = new Date().toISOString();
			const before = structuredClone(totals);
			for (const name of Object.keys(hist)) delete hist[name];
			const hot = candidates.filter((t) => t.hot),
				warm = candidates.filter((t) => !t.hot);
			const hotShare = Number(opt['hot-share'] ?? 0.8);
			let hotIndex = 0,
				warmIndex = 0;
			function nextThread(i) {
				if (!hot.length || !warm.length) return candidates[i % candidates.length];
				if (i % 100 < Math.round(hotShare * 100)) return hot[hotIndex++ % hot.length];
				return warm[warmIndex++ % warm.length];
			}
			const count = burst || Math.floor(rate * seconds);
			setPhase('messaging');
			measuredStart = performance.now();
			async function send(i, scheduled) {
				totals.offered++;
				if (abortReason) return;
				const thread = nextThread(i);
				const sender = states.get(
					thread.onlineMembers[Math.floor(i / candidates.length) % thread.onlineMembers.length],
				).account;
				const expected = (thread.expectedMembers ??= new Set(thread.onlineMembers));
				const m = {
					sequence: i,
					thread,
					sender,
					expected,
					scheduled,
					started: performance.now(),
					received: new Set(),
					unauthorized: new Set(),
					acked: new Set(),
					ackFailed: new Set(),
					ackRejected: new Set(),
					ackFinished: 0,
					duplicates: 0,
					deliveryMinMs: Infinity,
					deliveryMaxMs: 0,
					httpDone: false,
					success: false,
				};
				pending.set(i, m);
				activeSend++;
				totals.submitted++;
				record('submissionScheduleLagMs', m.started - scheduled);
				const body = {content: messageContent(sequenceBase + i), nonce: `${runId}-${i}`, allowed_mentions: {parse: []}};
				m.contentCharacters = [...body.content].length;
				m.contentUtf8Bytes = Buffer.byteLength(body.content, 'utf8');
				m.requestJsonUtf8Bytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
				const r = await request(`/channels/${thread.id}/messages`, states.get(sender.index).token, body, 'send');
				activeSend--;
				m.httpDone = true;
				m.httpStatus = r.status;
				m.httpMs = r.ms;
				m.messageId = r.data?.id;
				m.success = r.status >= 200 && r.status < 300 && !!m.messageId;
				if (m.success) {
					totals.sendSuccess++;
					totals.expectedDeliveries += expected.size;
					maybeFinish(m);
				} else {
					totals.sendFailed++;
					if (r.status === 429) totals.send429++;
					write('events', {
						type: 'send_failed',
						sequence: i,
						status: r.status,
						error: r.error,
						responseCode: r.data?.code,
					}); /* Timeout may still commit; keep correlation until drain. */
				}
			}
			if (burst) {
				await pool(
					Array.from({length: count}, (_, i) => i),
					concurrency,
					(i) => send(i + offset, performance.now()),
				);
			} else {
				const running = new Set();
				for (let i = 0; i < count; i++) {
					if (abortReason) break;
					const scheduled = measuredStart + (i * 1000) / rate;
					const wait = scheduled - performance.now();
					if (wait > 0) await sleep(wait);
					if (activeSend >= Number(opt['max-send-inflight'] || 1000)) {
						fail('Bounded send concurrency exceeded');
						break;
					}
					const p = send(i + offset, scheduled);
					running.add(p);
					p.finally(() => running.delete(p));
				}
				await Promise.all(running);
			}
			if (!burst && !abortReason) {
				const remainder = measuredStart + seconds * 1000 - performance.now();
				if (remainder > 0) await sleep(remainder);
			}
			submissionEnd = performance.now();
			setPhase('delivery_ack_drain');
			const deadline = performance.now() + drainMs;
			while ((pending.size || ackQueued || ackActive) && performance.now() < deadline && !abortReason) {
				await sleep(100);
				for (const m of [...pending.values()])
					if (m.httpDone && !m.success && performance.now() - m.started > Number(opt['http-timeout-ms'] || 30000))
						finish(m, true);
			}
			completeEnd = performance.now();
			drainIncomplete = !!(pending.size || ackQueued || ackActive);
			if (drainIncomplete)
				write('events', {type: 'drain_incomplete', pendingMessages: pending.size, ackQueued, ackActive, abortReason});
			for (const m of [...pending.values()]) finish(m, true);
			const stageTotals = Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, v - (before[k] || 0)]));
			{
				const totals = stageTotals;
				summary = {
					stage: activeStage,
					ackConcurrency,
					startedAt,
					finishedAt: new Date().toISOString(),
					completed: !abortReason,
					passed:
						!abortReason &&
						!drainIncomplete &&
						totals.sendFailed === 0 &&
						totals.missingDeliveries === 0 &&
						totals.missingAcks === 0 &&
						totals.unauthorizedDeliveries === 0 &&
						totals.duplicates === 0 &&
						totals.actualUniqueDeliveries === totals.expectedDeliveries &&
						totals.ackSuccess === totals.expectedDeliveries,
					abortReason,
					plannedMessageCount: count,
					requestedOnline: onlineTarget,
					actualOnlineBeforeExit: online(),
					rateMeaning: 'global new messages per second, not per user/channel',
					offeredRate: burst ? null : rate,
					scheduledWindowSeconds: burst ? null : seconds,
					meanExpectedRecipientsPerSuccessfulMessage: totals.sendSuccess
						? totals.expectedDeliveries / totals.sendSuccess
						: null,
					actualUniqueDeliveriesAcrossAllSubmittedMessages: totals.actualUniqueDeliveries,
					burst: burst ? {messages: burst, httpConcurrency: concurrency} : null,
					submissionSeconds: (submissionEnd - measuredStart) / 1000,
					completeSeconds: (completeEnd - measuredStart) / 1000,
					submittedPerSecond: totals.submitted / ((submissionEnd - measuredStart) / 1000),
					successfulSubmissionsPerSecond: totals.sendSuccess / ((submissionEnd - measuredStart) / 1000),
					fullyDrainedSuccessfulMessagesPerSecond:
						totals.missingDeliveries === 0 && totals.missingAcks === 0
							? totals.sendSuccess / ((completeEnd - measuredStart) / 1000)
							: null,
					payload: {
						characters: 20,
						contentUtf8Bytes: 60,
						encoding: '12 fixed Han characters plus eight Chinese digits; identical by sequence across runs',
						jsonRequestBytes: 'recorded per message; excludes HTTP headers/TLS/WebSocket response',
					},
					messageDistribution: {
						activeWithOnlineReaders: candidates.length,
						hotWithOnlineReaders: hot.length,
						warmWithOnlineReaders: warm.length,
						hotShare,
					},
					ackMode:
						'one real HTTP acknowledgement per message per recipient, serialized per user; 204 success, no retries',
					totals: structuredClone(totals),
					httpStatuses: structuredClone(httpStatuses),
					latencies: percentiles(),
					drainTimedOut: drainIncomplete,
					ackBacklogAtMeasurementEnd: ackQueued + ackActive,
				};
			}
			stages.push(summary);
			fs.writeFileSync(opt.out + '/stages.json', JSON.stringify(stages, null, 2));
			write('events', {type: 'stage_complete', result: summary});
			offset += count;
			if (!summary.passed || online() !== onlineTarget) {
				fail('Stage failed; stop before next workload');
				break;
			}
			if (globalThis.gc) globalThis.gc();
			activeStage = null;
			setPhase('recovery');
			await sleep(Number(opt['recovery-seconds'] || 5) * 1000);
		}
		summary = {
			startedAt: tierStartedAt,
			finishedAt: new Date().toISOString(),
			completed: !abortReason,
			passed:
				!abortReason && stages.length - stageStart === plan.length && stages.slice(stageStart).every((s) => s.passed),
			requestedOnline: onlineTarget,
			actualOnlineBeforeExit: online(),
			abortReason,
			stages: stages.slice(stageStart),
			loginLatencies,
			totals: structuredClone(totals),
		};
		summary.capacityPassed =
			summary.passed && summary.stages.every((s) => s.burst || s.completeSeconds <= s.scheduledWindowSeconds * 1.2);
		tiers.push(summary);
		fs.writeFileSync(opt.out + '/tiers.json', JSON.stringify(tiers, null, 2));
		if (summary.passed && !summary.capacityPassed) {
			if (opt['continue-after-capacity-failure'] === 'true') {
				write('events', {type: 'capacity_failed_continue_requested', online: onlineTarget});
			} else {
				fail('Completed all deliveries but sustained throughput fell below target; stop before increasing online');
				break;
			}
		}
		if (!summary.passed) break;
	}
	summary = {
		...summary,
		tiers,
		stages,
		requestedSteps: onlineSteps,
		highestPassedOnline: Math.max(0, ...tiers.filter((t) => t.passed).map((t) => t.requestedOnline)),
		highestCapacityPassedOnline: Math.max(0, ...tiers.filter((t) => t.capacityPassed).map((t) => t.requestedOnline)),
		allRequestedTiersPassed: tiers.length === onlineSteps.length && tiers.every((t) => t.passed),
	};
} catch (e) {
	fail(e.message);
	summary = {
		completed: false,
		tiers,
		stages,
		requestedOnline: onlineTarget,
		actualOnlineBeforeExit: [...states.values()].filter((s) => s.open && s.ready && s.synced).length,
		abortReason,
		totals: structuredClone(totals),
		httpStatuses: structuredClone(httpStatuses),
		latencies: percentiles(),
	};
} finally {
	clearTimeout(loginPhaseTimer);
	setPhase('exit');
	shuttingDown = true;
	ackReady.length = 0;
	for (const st of states.values()) st.ackQueue.length = 0;
	ackQueued = 0;
	for (const s of states.values()) {
		clearInterval(s.heartbeat);
		s.ws?.close(1000, 'benchmark end');
	}
	const ackExitDeadline = performance.now() + Number(opt['http-timeout-ms'] || 30000) + 2000;
	while (ackActive && performance.now() < ackExitDeadline) await sleep(100);
	await sleep(1000);
	clearInterval(sample);
	eld.disable();
	summary = {
		...summary,
		sequenceBase,
		operatorCancelled,
		operatorCancelReason,
		loginPhaseTimeoutSeconds,
		loginFailFast,
		loginPhaseStopped,
		loginPhaseDeadlineExceeded,
		readyOnlineAtLoginDeadline,
		finishedAt: new Date().toISOString(),
		node: process.version,
		kernel: os.release(),
		arch: os.arch(),
		generatorPid: process.pid,
		fixtureMetadata: fixture.metadata ?? null,
		measurementCaveats: [
			'Single generator host shares resources with application; generator metrics are separately logged.',
			'HTTP ACK 204 and received WS MESSAGE_ACK counts are distinct.',
			'A timed-out HTTP send can have committed; raw delivered recipients are retained but excluded from success denominator.',
			'Resource JSONL reports host/cgroup and generator only; server API/DB wait and gateway mailbox metrics require separate sampler.',
			'No extrapolation to production capacity.',
		],
		runOptions: Object.fromEntries(Object.entries(opt).filter(([k]) => !['fixture'].includes(k))),
	};
	fs.writeFileSync(`${opt.out}/summary.json`, JSON.stringify(summary, null, 2), {mode: 0o600});
	for (const stream of Object.values(streams)) stream.end();
	console.log(JSON.stringify(summary, null, 2));
}
