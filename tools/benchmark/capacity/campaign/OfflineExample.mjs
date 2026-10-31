// SPDX-License-Identifier: AGPL-3.0-or-later
import {createCampaignConfig} from './CampaignConfig.mjs';
import {runCampaign} from './RunCampaign.mjs';

/** Synthetic lifecycle example, not a transport or capacity validation result. */
export function exampleInput(outputRoot, attemptId = 'example') {
	return {
		capacity: {
			runId: 'offline-example',
			attemptId,
			environment: 'synthetic',
			scenarioSha256: '0'.repeat(64),
			outputRoot,
			workerIds: ['worker-a'],
			actors: [
				{id: 'author', cohort: 'member', threadId: 'thread'},
				{id: 'browser', cohort: 'browser', threadId: 'thread'},
			],
			authorIds: ['author'],
			maxMessagesPerStage: 100,
			phases: [
				{id: 'warmup', kind: 'warmup', durationSeconds: 1, targetFanoutRate: 2, ackIntervalMs: 10, drainNs: '1000000'},
				{
					id: 'steady-low',
					kind: 'steady',
					durationSeconds: 1,
					targetFanoutRate: 4,
					ackIntervalMs: 10,
					drainNs: '1000000',
				},
				{
					id: 'steady-high',
					kind: 'steady',
					durationSeconds: 1,
					targetFanoutRate: 6,
					ackIntervalMs: 10,
					drainNs: '1000000',
				},
			],
		},
		campaign: {
			sequenceStart: '0',
			startLeadNs: '1000000',
			maxInterstageGapNs: '1000000000',
			checkpointSettleNs: '1000000',
			finalAckTimeoutNs: '1000000000',
			failureTailTimeoutNs: '1000000000',
			operationTimeoutNs: '1000000000',
		},
		assessment: {synthetic: true},
	};
}
export async function runOfflineExample({outputRoot, attemptId = 'example', stopAfter, failStage, abortSignal} = {}) {
	const config = createCampaignConfig(exampleInput(outputRoot, attemptId));
	let now = 1000000000n,
		initialized = false,
		closed = false,
		current = null;
	const events = [],
		plans = [];
	const clock = {
		nowNs: () => now,
		sleepNs: async (ns) => {
			now += BigInt(ns);
		},
	};
	const driver = {
		async initialize(workload) {
			if (initialized) throw Error('Double initialize');
			initialized = true;
			events.push('initialize');
			return {actorsByWorker: new Map([['worker-a', workload.actors]])};
		},
		async runStage(plan) {
			current = plan.stageId;
			plans.push(plan);
			events.push(`run:${current}`);
			if (failStage === current) throw Error('Injected stage failure');
			now = BigInt(plan.drainEndNs);
		},
		async checkpoint({final}) {
			events.push(`checkpoint:${final}`);
			return {synthetic: true, stageId: current, closed};
		},
		async auditCursors({final}) {
			events.push(`cursors:${final}`);
			return {ok: true, readOnly: true, synthetic: true};
		},
		async drainAcks() {
			events.push('drain');
			return {complete: true, synthetic: true};
		},
		async close() {
			events.push('close');
			closed = true;
			return {realCloseVerified: true, cleanCloseVerified: true, errors: [], synthetic: true};
		},
		async cancel() {
			events.push('cancel');
			return {cancelled: true};
		},
		async failureTail() {
			events.push('failure-tail');
			return {partial: true};
		},
	};
	const observation = {
		async beginSafety() {
			events.push('safety-begin');
		},
		async endSafety() {
			events.push('safety-end');
			return {complete: true, safetyOnly: true, synthetic: true};
		},
		async beginStage() {},
		async endStage() {
			return {synthetic: true};
		},
		async cancel() {
			events.push('observation-cancel');
		},
	};
	const audit = async ({plan, final}) => ({
		stageId: plan.stageId,
		final,
		verified: true,
		decision: plan.stageId === stopAfter ? 'stop' : 'continue',
		synthetic: true,
	});
	try {
		const result = await runCampaign({
			config,
			driver,
			observation,
			clock,
			audit,
			nextGate: async () => ({mayAdvance: true}),
			frontierAudit: () => ({verified: true, synthetic: true}),
			signal: abortSignal,
		});
		return {synthetic: true, capacityClaim: false, result, events, plans};
	} catch (error) {
		error.events = events;
		throw error;
	}
}
