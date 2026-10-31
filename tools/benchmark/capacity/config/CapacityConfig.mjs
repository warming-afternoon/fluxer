// SPDX-License-Identifier: AGPL-3.0-or-later

import path from 'node:path';

const normalizedConfigs = new WeakSet();
const ARTIFACT_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;

/** 精确读取无符号整数，拒绝已经丢失精度的数字与隐式格式转换。 */
export function parseExactUnsigned(value, label) {
	if (typeof value === 'bigint' && value >= 0n) return value;
	if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
	if (typeof value === 'string' && /^(0|[1-9][0-9]{0,127})$/.test(value)) return BigInt(value);
	throw new Error(`${label} must be an exact unsigned integer`);
}

/** 仅接纳明确的标识和有界集合，不把凭据或部署对象复制到计划。 */
function identifiers(values, label, maximum) {
	if (!Array.isArray(values) || values.length === 0 || values.length > maximum)
		throw new Error(`${label} must be a nonempty bounded array`);
	const result = values.map((value) => {
		if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value))
			throw new Error(`${label} contains an invalid identity`);
		return value;
	});
	if (new Set(result).size !== result.length) throw new Error(`${label} contains duplicate identities`);
	return Object.freeze(result);
}

/** 将身份、路径、受众与阶段收敛为唯一不可变输入，不读取环境、不创建目录。 */
export function createCapacityConfig(input) {
	if (!input || typeof input !== 'object') throw new Error('Capacity configuration is required');
	const [runId] = identifiers([input.runId], 'runId', 1);
	const [environment] = identifiers([input.environment], 'environment', 1);
	const attemptId = input.attemptId;
	if (!ARTIFACT_SEGMENT.test(runId) || typeof attemptId !== 'string' || !ARTIFACT_SEGMENT.test(attemptId))
		throw new Error('Run and attempt identities must be portable artifact segments');
	if (typeof input.scenarioSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(input.scenarioSha256))
		throw new Error('Explicit source scenario SHA256 required');
	// runId 也是目录分量，拒绝保留路径符号；实例身份本身不承担授权含义。
	if (runId === '.' || runId === '..' || runId.includes(':'))
		throw new Error('runId must be a portable directory name');
	if (typeof input.outputRoot !== 'string' || !path.isAbsolute(input.outputRoot))
		throw new Error('outputRoot must be an explicit absolute directory');
	const baseRoot = path.resolve(input.outputRoot);
	const outRoot = path.join(baseRoot, runId, attemptId);
	const workerIds = identifiers(input.workerIds, 'workerIds', 1024);
	if (!Array.isArray(input.actors) || input.actors.length === 0 || input.actors.length > 1000000)
		throw new Error('actors must contain between one and one million entries');
	const actorIds = identifiers(
		input.actors.map((actor) => actor?.id),
		'actors',
		1000000,
	);
	const actors = input.actors.map((actor, index) => {
		if (!['member', 'browser'].includes(actor.cohort)) throw new Error('actor cohort must be member or browser');
		const [threadId] = identifiers([actor.threadId], 'threadId', 1);
		return Object.freeze({id: actorIds[index], cohort: actor.cohort, threadId});
	});
	const authorIds = identifiers(input.authorIds, 'authorIds', actors.length);
	const memberIds = new Set(actors.filter((actor) => actor.cohort === 'member').map((actor) => actor.id));
	if (authorIds.some((id) => !memberIds.has(id))) throw new Error('Every author must be a configured member actor');
	const cap = input.maxMessagesPerStage ?? 100000;
	if (!Number.isSafeInteger(cap) || cap < 1 || cap > 1000000)
		throw new Error('maxMessagesPerStage must be an integer between one and one million');
	if (!Array.isArray(input.phases) || input.phases.length === 0 || input.phases.length > 1024)
		throw new Error('phases must contain between one and 1024 entries');
	identifiers(
		input.phases.map((phase) => phase?.id),
		'phase IDs',
		1024,
	);
	const phases = input.phases.map((phase) => {
		if (!ARTIFACT_SEGMENT.test(phase.id)) throw new Error('Phase identity must be a portable artifact segment');
		if (!['warmup', 'steady'].includes(phase.kind)) throw new Error('phase kind must be warmup or steady');
		for (const key of ['durationSeconds', 'targetFanoutRate', 'ackIntervalMs']) {
			if (!Number.isSafeInteger(phase[key]) || phase[key] <= 0)
				throw new Error(`phase ${key} must be a positive safe integer`);
		}
		if (phase.ackIntervalMs > 2147483647) throw new Error('ACK interval exceeds the timer range');
		const drainNs = parseExactUnsigned(phase.drainNs, 'drainNs');
		if (drainNs === 0n) throw new Error('A positive final WebSocket drain window is required');
		return Object.freeze({
			id: phase.id,
			kind: phase.kind,
			durationSeconds: phase.durationSeconds,
			targetFanoutRate: phase.targetFanoutRate,
			ackIntervalMs: phase.ackIntervalMs,
			drainNs: String(drainNs),
		});
	});
	const config = Object.freeze({
		schema: 'benchmark.capacity-config.v1',
		runId,
		attemptId,
		scenarioSha256: input.scenarioSha256,
		environment,
		paths: Object.freeze({
			baseRoot,
			outRoot,
			recordPath: path.join(outRoot, 'record.json'),
			privateRoot: path.join(outRoot, 'private'),
			outputRoot: path.join(outRoot, 'out'),
		}),
		workerIds,
		actors: Object.freeze(actors),
		authorIds,
		phases: Object.freeze(phases),
		maxMessagesPerStage: cap,
	});
	normalizedConfigs.add(config);
	return config;
}

/** 验证实际记录仍绑定同一配置派生路径，不接受另一轮输出替换。 */
export function assertAttemptOutputBinding(config, {recordPath, record}) {
	assertCapacityConfig(config);
	const paths = config.paths;
	if (
		!paths ||
		typeof recordPath !== 'string' ||
		typeof record?.paths?.recordPath !== 'string' ||
		typeof record?.paths?.outRoot !== 'string' ||
		typeof record?.outRoot !== 'string' ||
		path.resolve(recordPath) !== paths.recordPath ||
		path.resolve(record.paths.recordPath) !== paths.recordPath ||
		record.paths.outRoot !== paths.outRoot ||
		record.outRoot !== paths.outRoot ||
		record.runId !== config.runId ||
		record.attemptId !== config.attemptId ||
		record.scenarioSha256 !== config.scenarioSha256 ||
		record.environment !== config.environment
	)
		throw new Error('Attempt record identity and output paths differ from the capacity configuration');
	return paths;
}

/** 只允许本模块校验并冻结过的配置进入计划，不能以同名字段绕过资源边界。 */
export function assertCapacityConfig(config) {
	if (!config || !normalizedConfigs.has(config))
		throw new Error('A normalized immutable capacity configuration is required');
	return config;
}
