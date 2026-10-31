// SPDX-License-Identifier: AGPL-3.0-or-later

import {assertCapacityConfig, parseExactUnsigned} from './CapacityConfig.mjs';

/** 用实际所有权顺序核实受众，并按整数纳秒生成无累计漂移的单帖子计划。 */
export function materializeStage(config, {phaseId, actorsByWorker, startNs, sequenceStart}) {
	// 配置只能由规范入口产生，防止跳过分配上限或集合校验。
	assertCapacityConfig(config);
	const phase = config.phases.find((entry) => entry.id === phaseId);
	if (!phase) throw new Error('Unknown phase');
	if (!(actorsByWorker instanceof Map) || actorsByWorker.size !== config.workerIds.length)
		throw new Error('Actual worker roster differs from the configured worker IDs');
	const configured = new Map(config.actors.map((actor) => [actor.id, actor]));
	const seen = new Set();
	const actorIds = [];
	let threadId;
	for (const workerId of config.workerIds) {
		const actors = actorsByWorker.get(workerId);
		if (!Array.isArray(actors) || actors.length === 0) throw new Error('Every configured worker must own actors');
		for (const actor of actors) {
			const expected = configured.get(actor?.id);
			if (!expected || seen.has(actor.id) || actor.cohort !== expected.cohort || actor.threadId !== expected.threadId)
				throw new Error('Actual actor roster has unknown, duplicate or changed actors');
			threadId ??= actor.threadId;
			if (actor.threadId !== threadId) throw new Error('This stage planner requires a single thread');
			seen.add(actor.id);
			actorIds.push(actor.id);
		}
	}
	if (seen.size !== configured.size) throw new Error('Actual roster omits configured actors');
	const recipients = BigInt(seen.size);
	const duration = BigInt(phase.durationSeconds) * 1000000000n;
	const fanout = BigInt(phase.targetFanoutRate) * BigInt(phase.durationSeconds);
	if (fanout % recipients !== 0n) throw new Error('Fanout and duration do not produce an integral message count');
	const count = fanout / recipients;
	if (count < 1n || count > BigInt(config.maxMessagesPerStage))
		throw new Error('Stage message count exceeds the configured allocation bound');
	const start = parseExactUnsigned(startNs, 'startNs');
	const sequence = parseExactUnsigned(sequenceStart, 'sequenceStart');
	const messages = Array.from({length: Number(count)}, (_, index) => ({
		sequence: String(sequence + BigInt(index)),
		channelId: threadId,
		authorId: config.authorIds[index % config.authorIds.length],
		scheduledMonoNs: String(start + (BigInt(index) * duration) / count),
	}));
	return {
		schema: 'benchmark.capacity-stage-plan.v1',
		runId: config.runId,
		attemptId: config.attemptId,
		scenarioSha256: config.scenarioSha256,
		environment: config.environment,
		stageId: phase.id,
		formalStartNs: String(start),
		formalEndNs: String(start + duration),
		drainEndNs: String(start + duration + BigInt(phase.drainNs)),
		messages,
		actorIds,
		plannedUnique: String(fanout),
		actualRecipientsPerMessage: seen.size,
		targetFanoutRate: phase.targetFanoutRate,
		plannedHttpRate: {numerator: String(phase.targetFanoutRate), denominator: String(recipients)},
		ackIntervalMs: phase.ackIntervalMs,
		legalAckDrainBetweenLevels: false,
	};
}
