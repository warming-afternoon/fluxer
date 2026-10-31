// SPDX-License-Identifier: AGPL-3.0-or-later

import {createHash} from 'node:crypto';
import {mergeSnapshots} from '../evidence/DeliveryAudit.mjs';
import {assessMixedCapacityTrend, createContinuationPolicy, RULES_VERSION} from './ContinuationRules.mjs';

const badCounters = [
	'duplicate',
	'unexpected',
	'wrongChannel',
	'unknownActor',
	'unplanned',
	'outsideStage',
	'outsideDrain',
	'invalidTimestamp',
	'submissionMismatch',
];
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const get = (map, key) => (map instanceof Map ? map.get(key) : map?.[key]);
const exact = (value) => {
	if (typeof value !== 'string' || !/^\d+$/.test(value)) throw Error('Exact decimal string required');
	return BigInt(value);
};
const check = (value, message) => {
	if (!value) throw Error(message);
};
const ms = (value) => Number(value) / 1e6;
const key = (row) => `${row.userId}:${row.channelId}`;

/** Verify actual ACK events and compare the committed frontier, not received frontier, between stages. */
export function auditAckFrontier({checkpoint, cursors, intervalMs, final = false, previousCheckpoint}) {
	const errors = [],
		events = checkpoint.ackEvents;
	if (!Array.isArray(events) || !cursors?.readOnly || !Array.isArray(cursors.rows))
		return {verified: false, status: 'unknown', errors: ['ACK events or readonly persisted rows missing']};
	const attempts = new Map(),
		completed = new Map(),
		lastStarted = new Map();
	let attemptCount = 0,
		completeCount = 0;
	for (const event of events) {
		const k = key(event),
			message = exact(event.messageId);
		if (event.kind === 'attempt') {
			attemptCount++;
			if (
				!Number.isFinite(event.startedAt) ||
				!Number.isFinite(event.queuedDue) ||
				event.startedAt < event.queuedDue ||
				(lastStarted.has(k) && event.startedAt - lastStarted.get(k) < intervalMs) ||
				attempts.has(k)
			)
				errors.push('illegal-ack-attempt');
			attempts.set(k, {message, startedAt: event.startedAt});
			lastStarted.set(k, event.startedAt);
		} else if (event.kind === 'complete') {
			completeCount++;
			const start = attempts.get(k);
			if (
				!start ||
				start.message !== message ||
				!Number.isFinite(event.finishedAt) ||
				event.finishedAt < start.startedAt ||
				event.succeeded !== true
			)
				errors.push('invalid-ack-completion');
			if (completed.has(k) && completed.get(k) > message) errors.push('ack-regression');
			if (event.succeeded === true) completed.set(k, message);
			attempts.delete(k);
		} else errors.push('unknown-ack-event');
	}
	const received = new Map(),
		persisted = new Map(),
		acknowledged = new Map();
	for (const [rows, target] of [
		[checkpoint.receivedCursors, received],
		[cursors.rows, persisted],
		[checkpoint.cursors, acknowledged],
	]) {
		if (!Array.isArray(rows)) return {verified: false, status: 'unknown', errors: ['Cursor rows missing']};
		for (const row of rows) {
			if (target.has(key(row))) errors.push('duplicate-cursor-key');
			target.set(key(row), row.messageId == null ? null : exact(row.messageId));
		}
	}
	if ([...completed.keys(), ...acknowledged.keys()].some((k) => !received.has(k))) errors.push('unknown-ack-key');
	if (persisted.size !== received.size || [...persisted.keys()].some((k) => !received.has(k)))
		errors.push('persisted-key-coverage');
	for (const [k, value] of received) {
		const ack = completed.get(k) ?? null,
			db = persisted.get(k) ?? null;
		if ((acknowledged.get(k) ?? null) !== ack) errors.push('ack-summary-event-mismatch');
		if (ack !== null && (value === null || ack > value)) errors.push('ack-ahead-of-receipt');
		// Legal ACK completion may advance during readonly queries; never force interstage drain.
		if (final ? db !== ack : db === null ? ack !== null : value === null || db > value || (ack !== null && db < ack))
			errors.push('persisted-committed-frontier-mismatch');
		if (final && (ack === null || ack !== value)) errors.push('final-frontier-not-exact');
	}
	for (const row of previousCheckpoint?.receivedCursors ?? [])
		if (received.has(key(row)) && exact(row.messageId) > received.get(key(row)))
			errors.push('interstage-receipt-regression');
	for (const row of previousCheckpoint?.cursors ?? [])
		if (!acknowledged.has(key(row)) || exact(row.messageId) > acknowledged.get(key(row)))
			errors.push('interstage-ack-regression');
	const stats = checkpoint.ack;
	if (
		!stats ||
		stats.httpRequests !== attemptCount ||
		stats.httpFailures !== 0 ||
		stats.cancelled !== false ||
		stats.active !== attempts.size ||
		completeCount + attempts.size !== attemptCount
	)
		errors.push('ack-telemetry-mismatch');
	if (final && (attempts.size || stats?.drained !== true || stats?.queued !== 0)) errors.push('final-ack-not-drained');
	return {
		verified: errors.length === 0,
		status: errors.length ? 'fail' : 'pass',
		errors: [...new Set(errors)],
		attemptCount,
		completeCount,
		committedKeys: completed.size,
		scope: final
			? 'exact final received/ACK/persisted frontier'
			: 'committed ACK frontier; legal received-to-ACK lag allowed',
	};
}

/** Reuse DeliveryAudit's bitmap proof, then bind every bit and message to the explicit scenario. */
export function auditDeliverySupply({config, plan, checkpoint, final = false}) {
	const snapshots = checkpoint.deliverySnapshots?.filter((row) => row.stageId === plan.stageId);
	check(snapshots?.length, 'Missing stage snapshots');
	const bitmapDataByWorker = checkpoint.bitmapDataByWorker;
	check(bitmapDataByWorker, 'Actual bitmap bytes required');
	const merged = mergeSnapshots(snapshots, {
		bitmapDataByWorker,
		expectedWorkerIds: config.workerIds,
		expectedActorIds: config.actors.map((row) => row.id),
		allowCheckpoints: !final,
	});
	check(!final || merged.snapshotKind === 'final', 'Final audit cannot use preview');
	for (const field of ['formalStartNs', 'formalEndNs', 'drainEndNs'])
		check(merged[field] === plan[field], 'Stage bounds mismatch');
	const messages = [...plan.messages].sort((a, b) => (exact(a.sequence) < exact(b.sequence) ? -1 : 1));
	const records = new Map(),
		ids = new Set();
	for (const row of (checkpoint.httpRecords ?? []).filter((row) => row.stageId === plan.stageId)) {
		check(!records.has(row.sequence), 'Duplicate HTTP sequence');
		records.set(row.sequence, row);
		check(
			row.success === true &&
				Number.isInteger(row.status) &&
				row.status >= 200 &&
				row.status < 300 &&
				exact(row.messageId) > 0n &&
				!ids.has(row.messageId),
			'HTTP admission failure or reused ID',
		);
		ids.add(row.messageId);
	}
	check(records.size === messages.length, 'HTTP planned coverage mismatch');
	let expectedUnique = 0,
		maxScheduleLagMs = 0,
		maxHttpLatencyMs = 0,
		maxTailMs = 0;
	const latest = new Map();
	for (const message of messages) {
		const row = records.get(message.sequence);
		check(
			row && ['channelId', 'authorId', 'scheduledMonoNs'].every((field) => row[field] === message[field]),
			'HTTP plan identity mismatch',
		);
		const lag = exact(row.actualSubmitMonoNs) - exact(row.scheduledMonoNs),
			duration = exact(row.httpCompleteMonoNs) - exact(row.actualSubmitMonoNs);
		check(lag >= 0n && duration >= 0n, 'HTTP timing order invalid');
		maxScheduleLagMs = Math.max(maxScheduleLagMs, ms(lag));
		maxHttpLatencyMs = Math.max(maxHttpLatencyMs, ms(duration));
		if (!latest.has(row.channelId) || exact(row.messageId) > exact(latest.get(row.channelId)))
			latest.set(row.channelId, row.messageId);
	}
	for (const snapshot of snapshots) {
		check(
			snapshot.runHash ===
				createHash('sha256')
					.update(`${config.runId}\0${config.attemptId}\0${config.scenarioSha256}`)
					.digest('hex')
					.slice(0, 24),
			'Scenario binding mismatch',
		);
		const actors = snapshot.actorIds.map((id) => config.actors.find((row) => row.id === id));
		check(actors.every(Boolean), 'Unknown recipient');
		check(
			snapshot.actorManifestSha256 ===
				hash(actors.map((row) => ({id: row.id, cohorts: [row.cohort], channelIds: [row.threadId]}))),
			'Actor manifest binding mismatch',
		);
		const normalized = messages.map((row) => ({
			sequence: row.sequence,
			channelId: row.channelId,
			scheduledMonoNs: row.scheduledMonoNs,
			messageId: row.messageId ?? null,
			inStage: true,
		}));
		check(
			snapshot.planSha256 ===
				hash({
					kind: 'explicit',
					messages: normalized,
					formalStartNs: plan.formalStartNs,
					formalEndNs: plan.formalEndNs,
					drainEndNs: plan.drainEndNs,
				}),
			'Snapshot plan binding mismatch',
		);
		const bits = get(bitmapDataByWorker, snapshot.workerId);
		check(bits.length === Math.ceil((messages.length * actors.length) / 8), 'Bitmap size mismatch');
		for (let i = 0; i < bits.length * 8; i++) {
			const message = messages[Math.floor(i / actors.length)],
				actor = actors[i % actors.length];
			const expected = Boolean(message && actor.threadId === message.channelId);
			check(Boolean(bits[i >> 3] & (1 << (i & 7))) === expected, 'Recipient bit or padding mismatch');
			if (expected) expectedUnique++;
		}
		const rows = get(checkpoint.messageRowsByWorker, snapshot.workerId) ?? snapshot.perMessagePage?.messages;
		check(Array.isArray(rows) && rows.length === messages.length, 'Full per-message summaries required');
		const seen = new Set();
		for (const row of rows) {
			const response = records.get(row.sequence),
				message = messages.find((m) => m.sequence === row.sequence);
			check(message && !seen.has(row.sequence), 'Duplicate or unexpected message summary');
			seen.add(row.sequence);
			const expected = actors.filter((actor) => actor.threadId === message.channelId).length;
			check(
				row.expected === expected &&
					row.actualUnique === expected &&
					row.missing === 0 &&
					row.channelId === message.channelId &&
					row.scheduledMonoNs === message.scheduledMonoNs,
				'Message recipient summary mismatch',
			);
			if (expected) {
				check(
					row.messageId === response.messageId && row.submitMonoNs === response.actualSubmitMonoNs,
					'WS/API message or submission mismatch',
				);
				check(row.maxReceiveNs != null, 'Actual receive timestamp missing');
				maxTailMs = Math.max(maxTailMs, ms(exact(row.maxReceiveNs) - exact(plan.formalEndNs)));
			}
		}
	}
	check(
		merged.actualUnique === expectedUnique &&
			merged.expectedUnique === expectedUnique &&
			merged.missingUnique === 0 &&
			badCounters.every((name) => (merged.counters[name] ?? 0) === 0),
		'Delivery quality failed',
	);
	check(exact(plan.plannedUnique) === BigInt(expectedUnique), 'Planned fanout differs from actual recipient closure');
	return {
		verified: true,
		merged,
		expectedUnique,
		maxScheduleLagMs,
		maxHttpLatencyMs,
		maxTailMs,
		expectedWatermarks: config.actors.map((actor) => ({
			userId: actor.id,
			channelId: actor.threadId,
			messageId: latest.get(actor.threadId) ?? null,
		})),
	};
}

/** Fail closed stage gate; malformed or absent evidence never grants continuation. */
export function auditStage({
	config,
	plan,
	checkpoint,
	cursors,
	observations,
	policy,
	final = false,
	previousCheckpoint,
}) {
	const result = {
		schema: 'benchmark.capacity-stage-assessment.v1',
		stageId: plan.stageId,
		final,
		verified: false,
		decision: 'unknown',
		errors: [],
	};
	try {
		check(
			policy &&
				['maxScheduleLagMs', 'maxHttpLatencyMs', 'maxWsLatencyMs'].every(
					(name) => Number.isFinite(policy[name]) && policy[name] >= 0,
				),
			'Explicit latency thresholds required',
		);
		result.delivery = auditDeliverySupply({config, plan, checkpoint, final});
		result.ack = auditAckFrontier({checkpoint, cursors, intervalMs: plan.ackIntervalMs, final, previousCheckpoint});
		check(
			checkpoint.errors?.length === 0 &&
				(final || checkpoint.readiness?.ready === config.actors.length) &&
				checkpoint.readiness?.expected === config.actors.length,
			'Transport readiness/errors failed',
		);
		if (final) check(checkpoint.realCloseVerified === true, 'Actual close evidence missing');
		{
			const received = new Map(checkpoint.receivedCursors.map((row) => [key(row), row.messageId]));
			check(received.size === config.actors.length, 'Receipt key coverage mismatch');
			// A later stage may advance a cursor; stage closure proves at least this stage frontier.
			for (const row of result.delivery.expectedWatermarks)
				check(
					received.has(key(row)) && exact(received.get(key(row))) >= exact(row.messageId),
					'Receipt frontier behind stage',
				);
		}
		result.latencyPassed =
			result.delivery.maxScheduleLagMs <= policy.maxScheduleLagMs &&
			result.delivery.maxHttpLatencyMs <= policy.maxHttpLatencyMs &&
			ms(exact(result.delivery.merged.latency.all.maxNs)) <= policy.maxWsLatencyMs;
		const limits = Object.entries(policy.resourceLimits ?? {});
		result.resources = {
			known:
				observations?.complete === true &&
				observations?.coverage?.pollingComplete === true &&
				observations?.stageId === plan.stageId &&
				observations?.window?.startNs != null &&
				observations?.window?.endNs != null &&
				exact(observations.window.startNs) <= exact(plan.formalStartNs) &&
				exact(observations.window.endNs) >= exact(plan.formalEndNs) &&
				limits.length > 0,
			passed: false,
			metrics: observations?.metrics ?? {},
		};
		result.resources.passed =
			result.resources.known &&
			limits.every(
				([name, limit]) =>
					Number.isFinite(limit.max) &&
					limit.max >= 0 &&
					observations.metrics?.[name]?.status === 'observed' &&
					Number.isFinite(observations.metrics[name].max) &&
					observations.metrics[name].max <= limit.max,
			);
		result.trend =
			config.phases?.find((phase) => phase.id === plan.stageId)?.kind === 'warmup'
				? {known: true, mayContinue: true, scope: 'Warmup quality gate only; no steady-capacity claim'}
				: assessTrend({
						plan,
						checkpoint,
						delivery: result.delivery,
						policy: policy.trend,
						observations,
						gates: {
							delivery: result.delivery.verified,
							ack: result.ack.verified,
							latency: result.latencyPassed,
							resource: result.resources.passed,
						},
					});
		result.verified =
			result.ack.verified &&
			result.latencyPassed &&
			result.resources.passed &&
			result.trend.known &&
			result.trend.mayContinue;
		result.decision = result.verified
			? 'continue'
			: !result.resources.known || !result.trend.known || result.ack.status === 'unknown'
				? 'unknown'
				: 'stop';
	} catch (error) {
		result.errors.push(error.message);
	}
	return result;
}

/** Conservative extra screen, never a substitute for the original quality gates. */
export function assessNextStage({current, next, assessment, policy}) {
	if (assessment?.verified !== true || assessment.decision !== 'continue')
		return {mayAdvance: false, reason: 'original-gates-not-passed'};
	const entries = Object.entries(policy?.nextStageLimits ?? {}),
		projected = {};
	const scale = next.targetFanoutRate / current.targetFanoutRate;
	if (!Number.isFinite(scale) || scale < 1) return {mayAdvance: false, reason: 'invalid-rate-scale'};
	for (const [name, limit] of entries) {
		const metric = assessment.resources?.metrics?.[name];
		if (metric?.status !== 'observed' || !Number.isFinite(metric.max) || !Number.isFinite(limit.max) || limit.max <= 0)
			return {mayAdvance: false, reason: 'headroom-evidence-unknown'};
		projected[name] = metric.max * scale;
	}
	return {
		mayAdvance: entries.every(([name, limit]) => projected[name] < limit.max),
		projected,
		scale,
		scope: 'Additional conservative linear screen; not capacity proof',
	};
}

/** Build exact R22 continuation inputs from actual delivery, HTTP and generator observations. */
export function assessTrend({plan, checkpoint, delivery, policy, observations, gates = {}}) {
	try {
		const origin = exact(plan.formalStartNs),
			end = exact(plan.formalEndNs);
		const relative = (value) => {
			const delta = exact(value) - origin;
			check(
				delta >= -BigInt(Number.MAX_SAFE_INTEGER) && delta <= BigInt(Number.MAX_SAFE_INTEGER),
				'Relative time exceeds safe precision',
			);
			return Number(delta) / 1e6;
		};
		const duration = relative(plan.formalEndNs) / 1000;
		const windowSeconds = delivery.merged.windowSeconds;
		const rules = createContinuationPolicy(policy, duration, windowSeconds);
		check(
			Array.isArray(checkpoint.timingPoints) && checkpoint.timingPoints.length <= 100000,
			'Bounded actual timing points required',
		);
		const count = (value) => {
			const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
			check(Number.isSafeInteger(number) && number >= 0, 'Exact safe timing count required');
			return number;
		};
		const timingPoints = checkpoint.timingPoints.map((row) => ({
			monoMs: relative(row.monoNs),
			submittedExpected: count(row.submittedExpected),
			successfulExpected: count(row.successfulExpected),
			uniqueWs: count(row.uniqueWs),
			pendingAgeMs: row.pendingAgeMs,
		}));
		check(
			timingPoints.every(
				(row) => row.successfulExpected <= row.submittedExpected && row.uniqueWs <= row.submittedExpected,
			),
			'Actual timing counter ordering invalid',
		);
		const records = checkpoint.httpRecords.filter((row) => row.stageId === plan.stageId);
		const histogram = (values) => {
			const bins = new Map();
			for (const value of values) {
				check(Number.isFinite(value) && value >= 0, 'Invalid latency value');
				const upper = value < 1 ? 1 : 1.01 ** (1 + Math.floor(Math.log(value) / Math.log(1.01)));
				bins.set(upper, (bins.get(upper) ?? 0) + 1);
			}
			return [...bins].sort((a, b) => a[0] - b[0]).map(([upperBoundMs, count]) => ({upperBoundMs, count}));
		};
		const latencyWindows = Array.from({length: rules.latencyWindowCount}, (_, index) => {
			const lower = index * windowSeconds * 1000,
				upper = lower + windowSeconds * 1000;
			const observed = delivery.merged.latency.windows.find((row) => row.windowId === index);
			check(
				observed &&
					Math.abs(relative(observed.startNs) - lower) < 0.001 &&
					Math.abs(relative(observed.endNs) - upper) < 0.001,
				'Exact receive-time latency window missing',
			);
			const bins = new Map();
			for (const metric of Object.values(observed.cohorts))
				for (const bin of metric.histogram?.bins ?? []) bins.set(bin.upperMs, (bins.get(bin.upperMs) ?? 0) + bin.count);
			const sent = records.filter(
				(row) => relative(row.actualSubmitMonoNs) >= lower && relative(row.actualSubmitMonoNs) < upper,
			);
			return {
				startMonoMs: lower,
				endMonoMs: upper,
				uniqueWsHistogram: [...bins]
					.sort((a, b) => a[0] - b[0])
					.map(([upperBoundMs, count]) => ({upperBoundMs, count})),
				scheduledLagHistogram: histogram(
					sent.map((row) => ms(exact(row.actualSubmitMonoNs) - exact(row.scheduledMonoNs))),
				),
				httpLatencyHistogram: histogram(
					sent.map((row) => ms(exact(row.httpCompleteMonoNs) - exact(row.actualSubmitMonoNs))),
				),
			};
		});
		const generator = observations?.generator;
		const workerSamples =
			generator?.known === true ? generator.workerSamples.map((row) => ({...row, monoMs: relative(row.monoNs)})) : [];
		const input = {
			rulesVersion: RULES_VERSION,
			policy: rules,
			targetFanoutRatePerSecond: plan.targetFanoutRate,
			formalWindow: {startMonoMs: 0, endMonoMs: Number(end - origin) / 1e6},
			timingPoints,
			latencyWindows,
			workerSamples,
			workerCoverage: generator?.known === true ? generator.workerCoverage : null,
			gates: Object.fromEntries(
				Object.entries(gates).map(([name, value]) => [
					name,
					{
						status: value === true ? 'pass' : value === false ? 'fail' : 'unknown',
						refs: [`stage:${plan.stageId}:${name}`],
					},
				]),
			),
			tail: {wsTailMs: delivery.maxTailMs, endWatermarkFanout: delivery.expectedUnique - delivery.merged.formalUnique},
		};
		const result = assessMixedCapacityTrend(input);
		const known =
			result.timingValidation.known &&
			result.formalWindow.known &&
			result.scheduledLatency.known &&
			result.httpLatency.known &&
			result.latency.known &&
			result.backlog.known &&
			result.generator.known &&
			result.qualityResourceAckGates.known &&
			result.tail.known;
		return {
			...result,
			known,
			mayContinue: known && result.decision.mayContinue,
			scope:
				'Source-derived continuation.v1 algorithms with explicit window/policy configuration; actual physical generator samples only',
		};
	} catch (error) {
		return {known: false, mayContinue: false, reason: error.message};
	}
}

/** Preview is never promoted; each completed stage must be re-audited after actual close. */
export function auditFinalArtifacts({stageAssessments, plannedStageIds, close, ackDrain}) {
	const errors = [];
	if (
		!Array.isArray(stageAssessments) ||
		!Array.isArray(plannedStageIds) ||
		new Set(stageAssessments.map((row) => row.stageId)).size !== stageAssessments.length
	)
		errors.push('invalid-stage-set');
	if (close?.realCloseVerified !== true) errors.push('real-close-unverified');
	if (ackDrain?.complete !== true) errors.push('legal-ack-drain-incomplete');
	if (stageAssessments?.some((row) => row.final !== true || row.verified !== true))
		errors.push('final-stage-audit-incomplete');
	const completed = new Set((stageAssessments ?? []).map((row) => row.stageId));
	if ((stageAssessments ?? []).some((row) => !(plannedStageIds ?? []).includes(row.stageId)))
		errors.push('unexpected-stage');
	const unrun = (plannedStageIds ?? []).filter((id) => !completed.has(id));
	return {
		verified: errors.length === 0 && unrun.length === 0,
		errors,
		unrun,
		throughCloseExtraFrames: 'unknown',
		scope:
			'Actual close and final planned-delivery audit do not prove transport observation of every extra frame through close',
	};
}
