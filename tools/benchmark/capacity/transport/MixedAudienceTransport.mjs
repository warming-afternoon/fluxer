// SPDX-License-Identifier: AGPL-3.0-or-later
import {createHash, randomUUID} from 'node:crypto';
import {DeliveryAudit} from '../evidence/DeliveryAudit.mjs';
import {orderedActorsByWorker} from '../runtime/ActorRoster.mjs';
import {ThrottledAckQueue} from '../runtime/ThrottledAckQueue.mjs';
import {WatchRetryController} from '../runtime/WatchRetryController.mjs';

const positive = (value) => Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
const decimal = (value) =>
	typeof value === 'string' && /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;
const fail = (code) => new Error(`capacity transport: ${code}`);
/** Cancellable monotonic wait; no wall-clock scheduling or catch-up burst. */
export function sleepMs(ms, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(fail('cancelled'));
		const done = () => {
			signal?.removeEventListener('abort', abort);
			resolve();
		};
		const timer = setTimeout(done, Math.max(0, ms));
		const abort = () => {
			clearTimeout(timer);
			signal?.removeEventListener('abort', abort);
			reject(fail('cancelled'));
		};
		signal?.addEventListener('abort', abort, {once: true});
	});
}
/** Concrete JSON Gateway + HTTP driver. Private credentials stay in this closure. */
export function createTransportDriver({
	config,
	credentials,
	transport: options,
	fetchImpl = globalThis.fetch,
	WebSocketImpl = globalThis.WebSocket,
	nowNs = () => process.hrtime.bigint(),
	sleep = sleepMs,
	cursorVerifier,
} = {}) {
	const o = {...options};
	if (o.requireSourceIpProof !== undefined && o.requireSourceIpProof !== false)
		throw fail('application_source_IP_proof_unsupported');
	const numericFields = [
		'loginConcurrency',
		'identifyGapMs',
		'readyTimeoutMs',
		'httpTimeoutMs',
		'closeTimeoutMs',
		'sendConcurrency',
		'membershipPageSize',
		'maxMembershipRows',
		'telemetryIntervalMs',
		'maxEvidenceEvents',
		'watchAckTimeoutMs',
		'watchRetryDelayMs',
		'watchMaxAttempts',
		'watchRenewalMs',
		'watchLeaseMs',
		'maxFrameBytes',
		'maxResponseBytes',
		'maxBitmapBytes',
		'windowSeconds',
	];
	const allowedOptions = new Set([...numericFields, 'apiBase', 'gatewayUrl', 'requireSourceIpProof']);
	if (Object.keys(o).some((key) => !allowedOptions.has(key))) throw fail('unknown_transport_option');
	for (const field of numericFields) if (!positive(o[field])) throw fail(`invalid ${field}`);
	if (o.watchRenewalMs + o.watchAckTimeoutMs * o.watchMaxAttempts >= o.watchLeaseMs)
		throw fail('watch timing exceeds lease');
	for (const [field, protocols] of [
		['apiBase', ['http:', 'https:']],
		['gatewayUrl', ['ws:', 'wss:']],
	]) {
		let url;
		try {
			url = new URL(o[field]);
		} catch {
			throw fail(`invalid ${field}`);
		}
		if (!protocols.includes(url.protocol) || url.username || url.password || url.hash) throw fail(`invalid ${field}`);
		if (field === 'gatewayUrl' && url.searchParams.has('compress')) throw fail('compressed Gateway unsupported');
		if (
			(field === 'apiBase' && url.search) ||
			(field === 'gatewayUrl' && [...url.searchParams.keys()].some((key) => !['v', 'encoding'].includes(key))) ||
			(url.searchParams.has('encoding') && url.searchParams.get('encoding') !== 'json')
		)
			throw fail('URL credential/query parameters unsupported');
	}
	if (typeof fetchImpl !== 'function' || typeof WebSocketImpl !== 'function')
		throw fail('HTTP and WebSocket implementations required');
	if (!config?.actors?.length || !credentials || !Array.isArray(credentials.actors))
		throw fail('private actor credentials required');
	if (new Set(config.phases.map((p) => p.ackIntervalMs)).size !== 1)
		throw fail('continuous ACK cadence must remain constant');
	const secrets = new Map();
	for (const item of credentials.actors) {
		if (
			!decimal(item.id) ||
			!decimal(item.guildId) ||
			typeof item.token !== 'string' ||
			!item.token ||
			/[\r\n]/.test(item.token) ||
			secrets.has(item.id)
		)
			throw fail('invalid private actor');
		secrets.set(item.id, {
			id: item.id,
			guildId: item.guildId,
			token: item.token,
			ackEligibilityVerified: item.ackEligibilityVerified === true,
		});
	}
	for (const actor of config.actors)
		if (!decimal(actor.id) || !decimal(actor.threadId) || !secrets.get(actor.id)?.ackEligibilityVerified)
			throw fail('all recipient ACK eligibility must be verified');
	for (const id of config.authorIds) if (!secrets.has(id)) throw fail('author credentials missing');
	const admission = credentials.admission;
	if (
		!admission ||
		!secrets.has(admission.readerId) ||
		!decimal(admission.threadId) ||
		!Array.isArray(admission.expectedFollowerIds) ||
		admission.expectedFollowerIds.some((id) => !decimal(id)) ||
		new Set(admission.expectedFollowerIds).size !== admission.expectedFollowerIds.length ||
		admission.expectedFollowerIds.length > o.maxMembershipRows ||
		o.membershipPageSize > 100 ||
		config.actors.some((a) => a.threadId !== admission.threadId)
	)
		throw fail('explicit exact follower admission manifest required');
	let admissionProof = null;
	const abort = new AbortController(),
		states = new Map(),
		stages = new Map(),
		sequenceStages = new Map(),
		errors = [],
		ackEvents = [];
	const runHash = createHash('sha256')
		.update(`${config.runId}\0${config.attemptId}\0${config.scenarioSha256}`)
		.digest('hex')
		.slice(0, 24);
	let initialized = false,
		closing = false,
		closed = false,
		realCloseVerified = false,
		currentStage,
		roster;
	let identifyTail = Promise.resolve(),
		lastIdentify = null;
	const recordError = (code) => {
		if (!errors.includes(code)) errors.push(code);
	};
	const assertHealthy = () => {
		if (abort.signal.aborted || errors.length) throw fail(errors[0] ?? 'cancelled');
	};
	const nowMs = () => Number(nowNs()) / 1e6;
	const queue = new ThrottledAckQueue({
		intervalMs: config.phases[0].ackIntervalMs,
		concurrency: o.sendConcurrency,
		maxKeys: config.actors.length,
		now: nowMs,
		originMs: nowMs(),
		failed: () => recordError('ack_failed'),
		onAttempt: (event) => {
			if (ackEvents.length >= o.maxEvidenceEvents) recordError('ack_evidence_bound');
			else ackEvents.push({...event});
		},
		send: async (actor, entry) => {
			await request(
				actor.id,
				`/channels/${entry.channelId}/messages/${entry.messageId}/ack`,
				{mention_count: 0},
				false,
			);
		},
	});
	/** Never retain remote bodies/errors, which can contain credentials or private paths. */
	async function request(actorId, route, body, json, method = 'POST') {
		let response;
		try {
			response = await fetchImpl(o.apiBase.replace(/\/$/, '') + route, {
				method,
				headers: {Authorization: secrets.get(actorId).token, 'Content-Type': 'application/json'},
				...(body === undefined ? {} : {body: JSON.stringify(body)}),
				signal: AbortSignal.any([abort.signal, AbortSignal.timeout(o.httpTimeoutMs)]),
			});
		} catch {
			throw fail('http_transport_failed');
		}
		if (!response.ok) throw fail(`http_status_${Number(response.status)}`);
		if (!json) {
			await response.body?.cancel?.();
			return {status: response.status};
		}
		let raw = '',
			reader;
		try {
			reader = response.body?.getReader?.();
			if (!reader) throw fail('streaming_response_required');
			let bytes = 0;
			const chunks = [];
			for (;;) {
				const {value, done} = await reader.read();
				if (done) break;
				bytes += value.byteLength;
				if (bytes > o.maxResponseBytes) throw fail('response_bound');
				chunks.push(Buffer.from(value));
			}
			raw = Buffer.concat(chunks).toString('utf8');
			return {status: response.status, body: JSON.parse(raw)};
		} catch {
			await reader?.cancel?.().catch(() => {});
			throw fail('invalid_or_oversized_http_response');
		}
	}
	function send(state, packet) {
		try {
			state.ws.send(JSON.stringify(packet));
		} catch {
			throw fail('gateway_send_failed');
		}
	}
	function invalidate(state, code) {
		state.ready = false;
		recordError(code);
		state.rejectReady?.(fail(code));
	}
	function markReady(state) {
		if (
			state.protocolReady &&
			state.guildAvailable &&
			(state.actor.cohort === 'member' ? state.threadSeen : state.watchAccepted)
		) {
			state.ready = true;
			state.resolveReady();
		}
	}
	function watch(state, renewal = false) {
		if (closing || abort.signal.aborted) return;
		if (renewal) {
			state.cycle++;
			state.watchAttempts = 0;
		}
		if (++state.watchAttempts > o.watchMaxAttempts) return invalidate(state, 'watch_attempts_exhausted');
		state.nonce = randomUUID();
		state.retry.begin({nonce: state.nonce, cycle: state.cycle});
		send(state, {
			op: 14,
			d: {
				thread_watch_nonce: state.nonce,
				subscriptions: {[state.secret.guildId]: {thread_watches: [state.actor.threadId]}},
			},
		});
		state.retry.schedule(o.watchAckTimeoutMs, () => state.retry.schedule(o.watchRetryDelayMs, () => watch(state)));
	}
	function guild(state, data) {
		if (!data || String(data.id) !== state.secret.guildId || data.unavailable === true || !Array.isArray(data.threads))
			return;
		state.guildAvailable = true;
		state.threadSeen ||= data.threads.some((t) => String(t.id) === state.actor.threadId);
		if (!state.subscribed) {
			state.subscribed = true;
			send(state, {
				op: 14,
				d: {
					subscriptions: {
						[state.secret.guildId]: {
							threads: true,
							...(state.actor.cohort === 'browser' ? {thread_member_lists: []} : {}),
						},
					},
				},
			});
			if (state.actor.cohort === 'browser') watch(state);
		}
		markReady(state);
	}
	function receive(state, data) {
		if (String(data.channel_id) !== state.actor.threadId) return;
		const match = typeof data.content === 'string' && /^capacity:([a-f0-9]{24}):(\d+):(\d+)$/.exec(data.content);
		if (!match || match[1] !== runHash) {
			recordError('foreign_thread_message');
			return;
		}
		const stage = sequenceStages.get(match[2]);
		if (!stage || !decimal(data.id)) {
			recordError('unknown_or_invalid_message');
			return;
		}
		const message = stage.bySequence.get(match[2]);
		if (
			String(data.author?.id) !== message.authorId ||
			String(data.channel_id) !== message.channelId ||
			stage.submissions.get(match[2]) !== match[3]
		) {
			recordError('message_identity_mismatch');
			return;
		}
		const audit = stage.audits.get(state.workerId);
		const accepted = audit.record({
			actorId: state.actor.id,
			sequence: match[2],
			channelId: message.channelId,
			messageId: data.id,
			submitMonoNs: match[3],
			receivedMonoNs: String(nowNs()),
		});
		if (accepted.qualityAccepted) stage.uniqueBySequence.set(match[2], (stage.uniqueBySequence.get(match[2]) ?? 0) + 1);
		stage.sample?.();
		queue.enqueue(state.actor, {channelId: message.channelId, messageId: data.id});
	}
	function packet(state, event) {
		try {
			if (typeof event.data !== 'string' || Buffer.byteLength(event.data) > o.maxFrameBytes)
				throw fail('non_json_or_oversized_gateway_frame');
			const p = JSON.parse(event.data);
			if (p.s != null) state.seq = p.s;
			if (p.op === 10) {
				if (state.hello || !positive(p.d?.heartbeat_interval)) throw fail('invalid_gateway_hello');
				state.hello = true;
				const beat = () => {
					if (!closing && !abort.signal.aborted) {
						if (state.awaitHeartbeat) return invalidate(state, 'heartbeat_ack_missing');
						state.awaitHeartbeat = true;
						try {
							send(state, {op: 1, d: state.seq ?? null});
						} catch {
							invalidate(state, 'heartbeat_failed');
						}
					}
				};
				state.heartbeat = setInterval(beat, p.d.heartbeat_interval);
				beat();
				identifyTail = identifyTail
					.then(async () => {
						if (lastIdentify !== null) await waitUntil(lastIdentify + BigInt(o.identifyGapMs) * 1000000n);
						assertHealthy();
						lastIdentify = nowNs();
						send(state, {
							op: 2,
							d: {
								token: state.secret.token,
								flags: 4,
								properties: {os: process.platform, browser: 'capacity-tool', device: 'capacity-tool'},
								initial_guild_id: state.secret.guildId,
								presence: {status: 'online', afk: false, since: 0},
							},
						});
					})
					.catch(() => invalidate(state, 'identify_failed'));
			} else if (p.op === 11) state.awaitHeartbeat = false;
			else if (p.op === 1) send(state, {op: 1, d: state.seq ?? null});
			else if (p.op === 7 || p.op === 9) invalidate(state, 'gateway_reconnect_requested');
			else if (p.op === 0) {
				if (p.t === 'READY') {
					if (!p.d?.session_id || String(p.d?.user?.id) !== state.actor.id) throw fail('ready_identity_mismatch');
					state.protocolReady = true;
					send(state, {op: 14, d: {subscriptions: {[state.secret.guildId]: {active: true, sync: true}}}});
					guild(
						state,
						p.d.guilds?.find((g) => String(g.id) === state.secret.guildId),
					);
				} else if (p.t === 'GUILD_CREATE') guild(state, p.d);
				else if (p.t === 'THREAD_LIST_SYNC' && String(p.d?.guild_id) === state.secret.guildId) {
					state.threadSeen ||= p.d.threads?.some((t) => String(t.id) === state.actor.threadId);
					markReady(state);
				} else if (p.t === 'THREAD_WATCH_ACK' && p.d?.nonce === state.nonce) {
					if (
						p.d.ok !== true ||
						!Array.isArray(p.d.thread_ids) ||
						p.d.thread_ids.length !== 1 ||
						String(p.d.thread_ids[0]) !== state.actor.threadId
					) {
						state.retry.schedule(o.watchRetryDelayMs, () => watch(state));
						return;
					}
					state.retry.acknowledge({nonce: state.nonce, cycle: state.cycle});
					state.watchAccepted = true;
					clearTimeout(state.leaseExpiry);
					state.leaseExpiry = setTimeout(() => invalidate(state, 'watch_lease_expired'), o.watchLeaseMs);
					clearTimeout(state.renewal);
					state.renewal = setTimeout(() => {
						try {
							watch(state, true);
						} catch {
							invalidate(state, 'watch_renewal_failed');
						}
					}, o.watchRenewalMs);
					markReady(state);
				} else if (p.t === 'MESSAGE_CREATE') receive(state, p.d ?? {});
				else if (
					(p.t === 'THREAD_DELETE' && String(p.d?.id) === state.actor.threadId) ||
					(p.t === 'GUILD_DELETE' && String(p.d?.id) === state.secret.guildId)
				)
					invalidate(state, 'subscription_removed');
			}
		} catch {
			invalidate(state, 'gateway_protocol_failed');
		}
	}
	async function waitUntil(deadline, signal = abort.signal) {
		while (nowNs() < deadline) await sleep(Math.min(Number(deadline - nowNs()) / 1e6, 1000), signal);
	}
	async function connect(actor, workerId) {
		const state = {
			actor,
			workerId,
			secret: secrets.get(actor.id),
			cycle: 0,
			watchAttempts: 0,
			retry: new WatchRetryController(),
			ready: false,
			closeObserved: false,
		};
		states.set(actor.id, state);
		let timer;
		const ready = new Promise((resolve, reject) => {
			state.resolveReady = resolve;
			state.rejectReady = reject;
			timer = setTimeout(() => reject(fail('readiness_timeout')), o.readyTimeoutMs);
		});
		try {
			state.ws = new WebSocketImpl(o.gatewayUrl);
			state.closePromise = new Promise((resolve) => {
				state.ws.addEventListener('close', (event) => {
					state.closeObserved = true;
					state.cleanClose = event.code === 1000 && event.wasClean === true;
					if (!state.cleanClose) recordError('unclean_socket_close');
					state.ready = false;
					clearInterval(state.heartbeat);
					state.retry.close();
					clearTimeout(state.renewal);
					clearTimeout(state.leaseExpiry);
					if (!closing) invalidate(state, 'unexpected_socket_close');
					resolve();
				});
			});
			state.ws.addEventListener('message', (event) => packet(state, event));
			state.ws.addEventListener('error', () => invalidate(state, 'socket_error'));
			await ready;
		} catch {
			recordError('initialization_failed');
			throw fail('initialization_failed');
		} finally {
			clearTimeout(timer);
		}
	}
	/** Authoritative bounded bot-only thread member listing, never a stale supplied success flag. */
	async function verifyAdmission() {
		const actual = new Set(),
			expected = new Set(admission.expectedFollowerIds);
		let after = null;
		for (;;) {
			const {body} = await request(
				admission.readerId,
				`/channels/${admission.threadId}/thread-members?with_member=false&limit=${o.membershipPageSize}${after ? '&after=' + after : ''}`,
				undefined,
				true,
				'GET',
			);
			if (!Array.isArray(body) || body.length > o.membershipPageSize) throw fail('invalid_membership_page');
			for (const row of body) {
				const id = row.user_id;
				if (
					!decimal(id) ||
					(after && BigInt(id) <= BigInt(after)) ||
					actual.has(id) ||
					(row.id != null && String(row.id) !== admission.threadId)
				)
					throw fail('invalid_membership_pagination');
				actual.add(id);
				after = id;
				if (actual.size > o.maxMembershipRows) throw fail('membership_bound');
			}
			if (body.length < o.membershipPageSize) break;
		}
		if (actual.size !== expected.size || [...actual].some((id) => !expected.has(id)))
			throw fail('follower_supply_mismatch');
		for (const actor of config.actors)
			if (actual.has(actor.id) !== (actor.cohort === 'member')) throw fail('recipient_membership_mismatch');
		admissionProof = {
			readOnly: true,
			source: 'thread-members-api',
			verified: true,
			followerCount: actual.size,
			followerIds: [...actual],
			expectedFollowerSha256: createHash('sha256')
				.update(JSON.stringify([...expected].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1))))
				.digest('hex'),
			memberRecipientCount: config.actors.filter((a) => a.cohort === 'member').length,
			browserRecipientCount: config.actors.filter((a) => a.cohort === 'browser').length,
			observedMonoNs: String(nowNs()),
		};
	}
	async function initialize() {
		if (initialized || states.size) throw fail('initialize_once_only');
		await verifyAdmission();
		let index = 0;
		const owner = new Map();
		try {
			await Promise.all(
				Array.from({length: Math.min(o.loginConcurrency, config.actors.length)}, async () => {
					while (index < config.actors.length) {
						assertHealthy();
						const i = index++,
							actor = config.actors[i],
							workerId = config.workerIds[i % config.workerIds.length];
						await connect(actor, workerId);
						owner.set(actor.id, workerId);
					}
				}),
			);
		} catch {
			await cancel('initialize_failed');
			throw fail('initialize_failed');
		}
		roster = orderedActorsByWorker(config.actors, config.workerIds, owner);
		initialized = true;
		return {actorsByWorker: roster, admission: admissionProof};
	}
	async function runStage(plan, {signal} = {}) {
		assertHealthy();
		if (!initialized || closing || stages.has(plan.stageId)) throw fail('invalid_stage_transition');
		if (plan.ackIntervalMs !== queue.intervalMs) throw fail('ACK cadence changed');
		if (plan.messages.length > config.maxMessagesPerStage) throw fail('message_bound');
		const stage = {
			plan,
			audits: new Map(),
			httpRecords: [],
			bySequence: new Map(plan.messages.map((m) => [m.sequence, m])),
			submissions: new Map(),
			uniqueBySequence: new Map(),
			timingPoints: [],
		};
		for (const [workerId, actors] of roster)
			stage.audits.set(
				workerId,
				new DeliveryAudit({
					runHash,
					workerId,
					stageId: plan.stageId,
					actors: actors.map((a) => ({...a, channelIds: [a.threadId]})),
					messages: plan.messages,
					formalStartNs: plan.formalStartNs,
					formalEndNs: plan.formalEndNs,
					drainEndNs: plan.drainEndNs,
					windowSeconds: o.windowSeconds,
					maxBitmapBytes: o.maxBitmapBytes,
				}),
			);
		for (const m of plan.messages) {
			if (sequenceStages.has(m.sequence)) throw fail('reused_sequence');
			sequenceStages.set(m.sequence, stage);
		}
		stages.set(plan.stageId, stage);
		currentStage = stage;
		const onAbort = () => {
			abort.abort();
			recordError('stage_cancelled');
		};
		signal?.addEventListener('abort', onAbort, {once: true});
		if (signal?.aborted) onAbort();
		const sample = (force = false) => {
			if (
				!force &&
				stage.timingPoints.length &&
				nowNs() - BigInt(stage.timingPoints.at(-1).monoNs) < BigInt(o.telemetryIntervalMs) * 1000000n
			)
				return;
			if (stage.timingPoints.length >= o.maxEvidenceEvents) {
				recordError('timing_evidence_bound');
				return;
			}
			const at = nowNs(),
				received = [...stage.audits.values()].reduce((n, a) => n + a.snapshot().qualityUnique, 0);
			const pending = stage.httpRecords.filter(
				(r) => (stage.uniqueBySequence.get(r.sequence) ?? 0) < config.actors.length,
			);
			stage.timingPoints.push({
				monoNs: String(at),
				submittedExpected: String(BigInt(stage.httpRecords.length) * BigInt(config.actors.length)),
				successfulExpected: String(
					BigInt(stage.httpRecords.filter((r) => r.success).length) * BigInt(config.actors.length),
				),
				uniqueWs: String(received),
				pendingAgeMs: pending.length
					? Math.max(...pending.map((r) => Number(at - BigInt(r.actualSubmitMonoNs)) / 1e6))
					: 0,
			});
		};
		stage.sample = sample;
		await waitUntil(BigInt(plan.formalStartNs));
		sample(true);
		const sampler = setInterval(sample, o.telemetryIntervalMs);
		let index = 0;
		try {
			await Promise.all(
				Array.from({length: Math.min(o.sendConcurrency, plan.messages.length)}, async () => {
					while (index < plan.messages.length) {
						const m = plan.messages[index++];
						await waitUntil(BigInt(m.scheduledMonoNs));
						assertHealthy();
						const actual = String(nowNs());
						if (BigInt(actual) >= BigInt(plan.formalEndNs)) throw fail('submission_outside_formal_window');
						stage.submissions.set(m.sequence, actual);
						for (const audit of stage.audits.values())
							audit.recordSubmission({sequence: m.sequence, submitMonoNs: actual});
						const row = {
							...m,
							stageId: plan.stageId,
							actualSubmitMonoNs: actual,
							httpCompleteMonoNs: null,
							status: null,
							messageId: null,
							success: false,
						};
						stage.httpRecords.push(row);
						try {
							const result = await request(
								m.authorId,
								`/channels/${m.channelId}/messages`,
								{
									content: `capacity:${runHash}:${m.sequence}:${actual}`,
									nonce: `${runHash}:${m.sequence}`,
									allowed_mentions: {parse: []},
								},
								true,
							);
							row.status = result.status;
							if (
								!decimal(result.body.id) ||
								String(result.body.channel_id) !== m.channelId ||
								String(result.body.author?.id) !== m.authorId
							)
								throw fail('http_response_identity');
							row.messageId = result.body.id;
							row.success = true;
						} catch {
							recordError('message_http_failed');
						} finally {
							row.httpCompleteMonoNs = String(nowNs());
							sample();
						}
					}
				}),
			);
			await waitUntil(BigInt(plan.formalEndNs));
			while (
				nowNs() < BigInt(plan.drainEndNs) &&
				[...stage.audits.values()].some((a) => a.snapshot().qualityUnique < a.snapshot().expectedUnique)
			) {
				assertHealthy();
				await sleep(Math.min(25, Number(BigInt(plan.drainEndNs) - nowNs()) / 1e6), abort.signal);
			}
			assertHealthy();
			return checkpoint({stageId: plan.stageId});
		} catch (error) {
			abort.abort();
			queue.cancel();
			throw error;
		} finally {
			clearInterval(sampler);
			sample(true);
			signal?.removeEventListener('abort', onAbort);
		}
	}
	function checkpoint({final = false, stageId = currentStage?.plan.stageId} = {}) {
		const stage = stages.get(stageId);
		if (!stage) throw fail('stage_missing');
		const finalized = final && realCloseVerified,
			snapshots = [],
			bitmapDataByWorker = new Map(),
			messageRowsByWorker = new Map();
		for (const [workerId, audit] of stage.audits) {
			const snapshot = finalized
				? audit.finalize({limit: config.maxMessagesPerStage})
				: audit.checkpoint({limit: config.maxMessagesPerStage});
			snapshots.push(snapshot);
			bitmapDataByWorker.set(workerId, audit.exportBitmap());
			messageRowsByWorker.set(workerId, snapshot.perMessagePage.messages);
		}
		const keys = queue.snapshot();
		return {
			stageId,
			admission: admissionProof,
			topology: {kind: 'single-process-logical-partitions', processCount: 1},
			timingPoints: stage.timingPoints.map((p) => ({...p})),
			deliverySnapshots: snapshots,
			bitmapDataByWorker,
			messageRowsByWorker,
			httpRecords: stage.httpRecords.map((r) => ({...r})),
			ack: {...queue.stats()},
			ackEvents: ackEvents.map((e) => ({...e})),
			ackKeys: keys,
			cursors: keys
				.filter((k) => k.acknowledged)
				.map((k) => ({userId: k.userId, channelId: k.channelId, messageId: k.acknowledged})),
			receivedCursors: keys
				.filter((k) => k.received)
				.map((k) => ({userId: k.userId, channelId: k.channelId, messageId: k.received})),
			errors: [...errors],
			readiness: {expected: config.actors.length, ready: [...states.values()].filter((s) => s.ready).length},
			allRecipients: true,
			realCloseVerified,
			finalized,
		};
	}
	async function drainAcks(deadlineNs) {
		const deadline = BigInt(deadlineNs);
		while (!queue.stats().drained && nowNs() < deadline) {
			queue.pump();
			await sleep(Math.min(25, Number(deadline - nowNs()) / 1e6), abort.signal);
		}
		return {complete: queue.stats().drained && queue.stats().httpFailures === 0, ...queue.stats()};
	}
	async function close() {
		closing = true;
		for (const s of states.values()) {
			clearInterval(s.heartbeat);
			clearTimeout(s.renewal);
			clearTimeout(s.leaseExpiry);
			s.retry.close();
			try {
				s.ws?.close(1000, 'capacity completed');
			} catch {
				recordError('socket_close_failed');
			}
		}
		const timeoutAbort = new AbortController();
		try {
			await Promise.race([
				Promise.all([...states.values()].map((s) => s.closePromise)),
				sleep(o.closeTimeoutMs, timeoutAbort.signal),
			]);
		} finally {
			timeoutAbort.abort();
		}
		realCloseVerified = states.size === config.actors.length && [...states.values()].every((s) => s.closeObserved);
		closed = true;
		if (!realCloseVerified) recordError('socket_close_timeout');
		if (queue.stats().drained) await queue.close();
		else queue.cancel();
		return {
			realCloseVerified,
			cleanCloseVerified: realCloseVerified && [...states.values()].every((s) => s.cleanClose),
			closed,
			errors: [...errors],
		};
	}
	async function cancel() {
		abort.abort();
		queue.cancel();
		for (const s of states.values()) s.rejectReady?.(fail('cancelled'));
		return close();
	}
	async function auditCursors({checkpoint: cp, final = false}) {
		if (typeof cursorVerifier !== 'function') throw fail('read_only_cursor_verifier_required');
		try {
			const before = JSON.stringify(queue.snapshot());
			const result = await cursorVerifier({
				entries: config.actors.map((a) => ({
					userId: a.id,
					channelId: a.threadId,
					messageId: cp.cursors.find((c) => c.userId === a.id && c.channelId === a.threadId)?.messageId ?? null,
				})),
				received: cp.receivedCursors,
				final,
				signal: abort.signal,
			});
			if (final && JSON.stringify(queue.snapshot()) !== before) throw fail('cursor_frontier_changed');
			return {...result, frontierBefore: JSON.parse(before), frontierAfter: queue.snapshot()};
		} catch {
			throw fail('cursor_verification_failed');
		}
	}
	return Object.freeze({
		initialize,
		runStage,
		checkpoint,
		drainAcks,
		close,
		cancel,
		auditCursors,
		failureTail: async ({deadlineNs, allowLegalDrain = false} = {}) => {
			const drain =
				allowLegalDrain && !abort.signal.aborted && deadlineNs
					? await drainAcks(deadlineNs)
					: {complete: false, notRun: true};
			return {...(currentStage ? checkpoint() : {errors: [...errors]}), partial: true, drain};
		},
		nowNs,
	});
}
