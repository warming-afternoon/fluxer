// SPDX-License-Identifier: AGPL-3.0-or-later
import {setTimeout as delay} from 'node:timers/promises';
import {assessNextStage, auditAckFrontier, auditFinalArtifacts, auditStage} from '../audit/StageAudit.mjs';
import {assertCapacityConfig} from '../config/CapacityConfig.mjs';
import {materializeStage} from '../config/StagePlan.mjs';
import {createArtifactStore, readArtifact} from './ArtifactStore.mjs';

const systemClock = {
	nowNs: () => process.hrtime.bigint(),
	sleepNs: (ns, signal) => delay(Number((BigInt(ns) + 999999n) / 1000000n), undefined, {signal}),
};
/** One driver/session, continuous stages, legal final ACK tail. No deployment or service lifecycle operations. */
export async function runCampaign({
	config,
	driver,
	observation,
	clock = systemClock,
	audit = auditStage,
	nextGate = assessNextStage,
	frontierAudit = auditAckFrontier,
	signal,
}) {
	const workload = assertCapacityConfig(config.capacity),
		policy = config.policy;
	const store = await createArtifactStore(workload);
	const results = [],
		plans = [],
		controller = new AbortController();
	const forwardAbort = () => controller.abort(signal.reason);
	if (signal?.aborted) forwardAbort();
	else signal?.addEventListener('abort', forwardAbort, {once: true});
	let previousEnd = null,
		sequence = BigInt(policy.sequenceStart),
		previousCheckpoint = null,
		activePlan = null,
		closed = false,
		supplyEnded = false,
		unsafe = false,
		safetyCancellation = null;
	observation.setViolationHandler?.((error) => {
		unsafe = true;
		controller.abort(error instanceof Error ? error : Error(String(error)));
		safetyCancellation ??= Promise.resolve()
			.then(() => driver.cancel('Observation safety violation'))
			.catch(() => ({error: 'SAFETY_CANCELLATION_FAILED'}));
	});
	const check = () => {
		if (controller.signal.aborted) throw controller.signal.reason ?? Error('Campaign aborted');
	};
	// Timeout aborts active scheduling; cancellation in catch stops all owned driver work.
	async function bounded(label, fn, timeoutNs = policy.operationTimeoutNs) {
		check();
		let timer, abort;
		const timeout = new Promise((_, reject) => {
			timer = setTimeout(
				() => {
					const error = Error(`${label} timed out`);
					controller.abort(error);
					reject(error);
				},
				Math.ceil(Number(BigInt(timeoutNs)) / 1e6),
			);
		});
		const aborted = new Promise((_, reject) => {
			abort = () => reject(controller.signal.reason ?? Error('Campaign aborted'));
			controller.signal.addEventListener('abort', abort, {once: true});
			if (controller.signal.aborted) abort();
		});
		try {
			return await Promise.race([Promise.resolve().then(fn), timeout, aborted]);
		} finally {
			clearTimeout(timer);
			controller.signal.removeEventListener('abort', abort);
		}
	}
	const persist = (name, value) => store.write(name, value);
	try {
		await persist('CONFIG', {capacity: workload, policy, assessment: config.assessment, provenance: config.provenance});
		await bounded('initialization safety start', () => observation.beginSafety());
		const initialized = await bounded('initialize', () => driver.initialize(workload));
		const admissionObservation = await bounded('initialization safety end', () => observation.endSafety());
		await persist('ADMISSION-OBSERVATIONS', admissionObservation);
		if (admissionObservation.complete !== true || admissionObservation.safetyOnly !== true)
			throw Error('Initialization resource safety unverified');
		if (initialized.admission) await persist('ADMISSION', initialized.admission);
		for (let index = 0; index < workload.phases.length; index++) {
			check();
			const phase = workload.phases[index];
			if (index > 0) {
				const gate = await nextGate({
					current: workload.phases[index - 1],
					next: phase,
					assessment: results.at(-1).assessment,
					policy: config.assessment,
				});
				await persist(`${phase.id}.ADMISSION`, gate);
				if (gate.mayAdvance !== true && gate.mayContinue !== true) break;
			}
			const start = clock.nowNs() + BigInt(policy.startLeadNs);
			const gap = previousEnd === null ? null : start - previousEnd;
			if (gap !== null && (gap < 0n || gap > BigInt(policy.maxInterstageGapNs)))
				throw Error('Continuous interstage gap exceeds policy');
			const plan = materializeStage(workload, {
				phaseId: phase.id,
				actorsByWorker: initialized.actorsByWorker,
				startNs: start,
				sequenceStart: sequence,
			});
			activePlan = plan;
			supplyEnded = false;
			plans.push(plan);
			sequence += BigInt(plan.messages.length);
			await persist(`${phase.id}.PLAN`, {...plan, previousGapNs: gap === null ? null : String(gap)});
			await bounded('observation begin', () => observation.beginStage(plan));
			await bounded(
				'stage execution',
				() => driver.runStage(plan, {signal: controller.signal}),
				BigInt(policy.operationTimeoutNs) + BigInt(phase.durationSeconds) * 1000000000n + BigInt(phase.drainNs),
			);
			supplyEnded = true;
			previousEnd = BigInt(plan.formalEndNs);
			await bounded(
				'checkpoint settling',
				() => clock.sleepNs(policy.checkpointSettleNs, controller.signal),
				BigInt(policy.checkpointSettleNs) + BigInt(policy.operationTimeoutNs),
			);
			check();
			const checkpoint = await bounded('checkpoint', () => driver.checkpoint({final: false}));
			const cursors = await bounded('cursor audit', () => driver.auditCursors({checkpoint, final: false}));
			const observations = await bounded('observation end', () => observation.endStage(plan));
			const refs = {
				checkpoint: await persist(`${phase.id}.CHECKPOINT`, checkpoint),
				cursors: await persist(`${phase.id}.CURSORS`, cursors),
				observations: await persist(`${phase.id}.OBSERVATIONS`, observations),
			};
			const assessment = await audit({
				config: workload,
				plan,
				checkpoint,
				cursors,
				observations,
				policy: config.assessment,
				previousCheckpoint,
				final: false,
			});
			const row = {stageId: phase.id, kind: phase.kind, status: 'executed', assessment, refs};
			results.push(row);
			await persist(`${phase.id}.RESULT`, row);
			previousCheckpoint = checkpoint;
			activePlan = null;
			if (assessment.decision !== 'continue' && assessment.mayContinue !== true) break;
		}
		const deadlineNs = String(clock.nowNs() + BigInt(policy.finalAckTimeoutNs));
		const drain = await bounded('final ACK drain', () => driver.drainAcks(deadlineNs), policy.finalAckTimeoutNs);
		await persist('FINAL-ACK-DRAIN', {deadlineNs, inPerformanceWindow: false, ...drain});
		if (drain.complete !== true) throw Error('Final legal ACK drain incomplete');
		const checkpoint = await bounded('final checkpoint', () => driver.checkpoint({final: true}));
		const cursors = await bounded('final exact cursor audit', () => driver.auditCursors({checkpoint, final: true}));
		const cursorRef = await persist('FINAL-EXACT-CURSORS', cursors);
		const storedFinalCursors = await readArtifact(store.root, cursorRef);
		const finalFrontier = frontierAudit({
			checkpoint,
			cursors: storedFinalCursors,
			intervalMs: workload.phases[0].ackIntervalMs,
			final: true,
		});
		await persist('FINAL-ACK-FRONTIER', finalFrontier);
		if (finalFrontier.verified !== true) throw Error('Final exact read-only cursor audit incomplete');
		const close = await bounded('real WebSocket close', () => driver.close());
		await persist('FINAL-CLOSE', close);
		if (close.realCloseVerified !== true || close.cleanCloseVerified !== true || close.errors?.length !== 0)
			throw Error('Real clean WebSocket close unverified');
		closed = true;
		for (const row of results) {
			const finalCheckpoint = await bounded('closed stage checkpoint', () =>
				driver.checkpoint({final: true, stageId: row.stageId}),
			);
			const checkpointRef = await persist(`${row.stageId}.FINAL-CHECKPOINT`, finalCheckpoint);
			const storedFinalCheckpoint = await readArtifact(store.root, checkpointRef);
			const observations = await readArtifact(store.root, row.refs.observations);
			row.finalAssessment = await audit({
				config: workload,
				plan: plans.find((p) => p.stageId === row.stageId),
				checkpoint: storedFinalCheckpoint,
				cursors: storedFinalCursors,
				observations,
				policy: config.assessment,
				final: true,
			});
			await persist(`${row.stageId}.FINAL-AUDIT`, row.finalAssessment);
		}
		const skipped = workload.phases
			.filter((p) => !results.some((r) => r.stageId === p.id))
			.map((p) => ({
				stageId: p.id,
				status: 'not-run',
				performance: 'not-evaluated',
				reason: 'Previous continuation or admission gate did not allow advancement',
			}));
		const finalArtifactAudit = auditFinalArtifacts({
			stageAssessments: results.map((row) => row.finalAssessment),
			plannedStageIds: workload.phases.map((p) => p.id),
			close,
			ackDrain: drain,
		});
		await persist('FINAL-ARTIFACT-AUDIT', finalArtifactAudit);
		const result = {
			finalArtifactAudit,
			schema: 'benchmark.capacity-campaign-result.v1',
			runId: workload.runId,
			attemptId: workload.attemptId,
			reservedStagesComplete: skipped.length === 0,
			complete: skipped.length === 0,
			performancePassed:
				finalArtifactAudit.verified &&
				skipped.length === 0 &&
				results.every((r) => r.assessment.verified === true && r.finalAssessment.verified === true),
			executionClosed: true,
			results,
			skipped,
			extraFramesThroughClose: 'unknown',
		};
		await bounded('observation close', () => observation.close?.());
		await persist('RESULT', result);
		// Re-read all evidence, not just file existence; final manifest excludes itself by design.
		for (const ref of store.manifest) await readArtifact(store.root, ref);
		await store.finish();
		return result;
	} catch (error) {
		controller.abort(error);
		const cleanup = {};
		// Cleanup needs its own non-aborted timeout; do not suppress or replace the primary failure.
		async function cleanupCall(name, fn) {
			let timer;
			try {
				cleanup[name] = await Promise.race([
					Promise.resolve().then(fn),
					new Promise((_, reject) => {
						timer = setTimeout(
							() => reject(Error(`${name} timeout`)),
							Math.ceil(Number(BigInt(policy.failureTailTimeoutNs)) / 1e6),
						);
					}),
				]);
			} catch (_e) {
				cleanup[name] = {error: 'CLEANUP_FAILED'};
			} finally {
				clearTimeout(timer);
			}
		}
		const legalTailAllowed = supplyEnded && !unsafe && !closed;
		if (legalTailAllowed && driver.failureTail)
			await cleanupCall('tail', () =>
				driver.failureTail({
					deadlineNs: String(clock.nowNs() + BigInt(policy.failureTailTimeoutNs)),
					activePlan,
					allowLegalDrain: true,
				}),
			);
		if (!closed) await cleanupCall('cancellation', () => safetyCancellation ?? driver.cancel('Campaign failed'));
		await cleanupCall('observation', () => observation.cancel?.());
		await cleanupCall('observationClose', () => observation.close?.());
		if (!legalTailAllowed && driver.failureTail)
			await cleanupCall('tail', () =>
				driver.failureTail({
					deadlineNs: String(clock.nowNs() + BigInt(policy.failureTailTimeoutNs)),
					activePlan,
					allowLegalDrain: false,
				}),
			);
		const failure = {
			partial: true,
			success: false,
			error: 'CAMPAIGN_FAILED',
			activeStageId: activePlan?.stageId ?? null,
			completedStages: results,
			cleanup,
		};
		try {
			await persist('FAILURE', failure);
			await store.finish();
		} catch (artifactError) {
			error.artifactError = artifactError.message;
		}
		error.partialResult = failure;
		throw error;
	} finally {
		signal?.removeEventListener('abort', forwardAbort);
	}
}
