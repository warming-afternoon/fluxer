// SPDX-License-Identifier: AGPL-3.0-or-later

import {constants as bufferConstants} from 'node:buffer';
import crypto from 'node:crypto';

const SCHEMA = 'fluxer.delivery-audit.v1';
const NS_PER_MS = 1_000_000n;
const DEFAULT_BITMAP_LIMIT = 512 * 1024 * 1024;
const DEFAULT_PAGE_SIZE = 1_000;
const DEFAULT_MISSING_SAMPLE = 8;
const LOG_BUCKET_STEP = Math.log(1.01);

/** 将计数统一转成可稳定比较的十进制序号。 */
function sequenceKey(value) {
	if (typeof value === 'number') {
		if (!Number.isSafeInteger(value) || value < 0)
			throw new TypeError('sequence must be a non-negative safe integer or decimal string');
		return String(value);
	}
	if (typeof value !== 'string' && typeof value !== 'bigint') throw new TypeError('invalid sequence type');
	if (!/^[0-9]+$/.test(String(value))) throw new TypeError('sequence must be decimal');
	const parsed = BigInt(value);
	if (parsed < 0n) throw new RangeError('sequence must be non-negative');
	return parsed.toString();
}

/** 将单调时钟字段转成BigInt，避免长运行时纳秒精度丢失。 */
function monoNs(value, fieldName) {
	if (typeof value === 'number' && !Number.isSafeInteger(value))
		throw new TypeError(fieldName + ' number must be safe; use a decimal string');
	if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint')
		throw new TypeError(fieldName + ' must be decimal nanoseconds');
	if (!/^[0-9]+$/.test(String(value))) throw new TypeError(fieldName + ' must be decimal nanoseconds');
	const result = BigInt(value);
	if (result < 0n) throw new RangeError(fieldName + ' must be non-negative');
	return result;
}

/** 保留业务标识原值，拒绝进入字符串前已经丢失精度的数字。 */
function scalarId(value) {
	if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) {
		throw new TypeError('identifier number must be a non-negative safe integer');
	}
	if (typeof value === 'bigint' && value < 0n) throw new TypeError('negative identifier');
	if (!['string', 'number', 'bigint'].includes(typeof value) || String(value).length === 0) {
		throw new TypeError('non-empty identifier required');
	}
	return String(value);
}

/** 用相同的稳定序列化形式生成审计清单摘要。 */
function sha256(value) {
	return crypto.createHash('sha256').update(value).digest('hex');
}

/** 生成有界的约1%相对宽度对数延迟桶编号。 */
function latencyBucket(latencyNs) {
	const ms = Number(latencyNs) / Number(NS_PER_MS);
	if (ms < 1) return 0;
	return 1 + Math.floor(Math.log(ms) / LOG_BUCKET_STEP);
}

/** 返回对数延迟桶的可读毫秒边界。 */
function latencyBucketBounds(index) {
	if (index === 0) return {lowerMs: 0, upperMs: 1};
	return {lowerMs: 1.01 ** (index - 1), upperMs: 1.01 ** index};
}

/** 向精确计数和稀疏延迟桶累计一条唯一接收。 */
function addLatency(metric, latencyNs) {
	const bucket = latencyBucket(latencyNs);
	metric.count += 1;
	metric.sumNs += latencyNs;
	metric.minNs = metric.minNs === null || latencyNs < metric.minNs ? latencyNs : metric.minNs;
	metric.maxNs = metric.maxNs === null || latencyNs > metric.maxNs ? latencyNs : metric.maxNs;
	metric.bins.set(bucket, (metric.bins.get(bucket) || 0) + 1);
}

/** 构造空的可合并延迟分布。 */
function emptyLatency() {
	return {count: 0, sumNs: 0n, minNs: null, maxNs: null, bins: new Map()};
}

/** 从桶计数求nearest-rank分位数，合并时绝不合并各分片p95。 */
function latencySummary(metric, quantile = 0.95) {
	const bins = [...metric.bins.entries()].sort((a, b) => a[0] - b[0]);
	let p95 = null;
	if (metric.count > 0) {
		const target = Math.ceil(metric.count * quantile);
		let seen = 0;
		for (const [bucket, count] of bins) {
			seen += count;
			if (seen >= target) {
				p95 = {bucket, ...latencyBucketBounds(bucket)};
				break;
			}
		}
	}
	return {
		count: metric.count,
		sumNs: metric.sumNs.toString(),
		meanMs: metric.count ? Number(metric.sumNs) / Number(NS_PER_MS) / metric.count : null,
		minNs: metric.minNs === null ? null : metric.minNs.toString(),
		maxNs: metric.maxNs === null ? null : metric.maxNs.toString(),
		p95,
		histogram: {
			kind: 'logarithmic-1-percent',
			bins: bins.map(([index, count]) => ({index, count, ...latencyBucketBounds(index)})),
		},
	};
}

/** 将可序列化摘要按键排序后计算校验和。 */
function checksumJson(value) {
	return sha256(Buffer.from(JSON.stringify(value)));
}

/** 比较两个decimal sequence，避免转成Number后排序失真。 */
function compareSequence(a, b) {
	const aa = BigInt(a);
	const bb = BigInt(b);
	return aa < bb ? -1 : aa > bb ? 1 : 0;
}

/** 维护一个worker的本地精确投递位图和可合并统计。 */
export class DeliveryAudit {
	/** 初始化worker排他拥有的actor、消息计划和受限位图。 */
	constructor({
		runHash,
		workerId = 'worker-0',
		stageId = 'stage',
		actors,
		messages,
		plan,
		formalStartNs,
		formalEndNs,
		drainEndNs,
		windowSeconds = 60,
		bounds = {},
		maxBitmapBytes = DEFAULT_BITMAP_LIMIT,
	}) {
		if (!runHash || !Array.isArray(actors)) throw new TypeError('runHash and actors are required');
		this.runHash = String(runHash);
		this.workerId = String(workerId);
		this.stageId = String(stageId);
		this.startNs = monoNs(formalStartNs, 'formalStartNs');
		this.endNs = monoNs(formalEndNs, 'formalEndNs');
		if (this.endNs <= this.startNs) throw new RangeError('formalEndNs must be after formalStartNs');
		this.drainEndNs = drainEndNs === undefined ? this.endNs + 240_000_000_000n : monoNs(drainEndNs, 'drainEndNs');
		if (this.drainEndNs <= this.endNs) throw new RangeError('drainEndNs must be after formalEndNs');
		if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) throw new RangeError('windowSeconds must be positive');
		if (!Number.isSafeInteger(maxBitmapBytes) || maxBitmapBytes <= 0)
			throw new RangeError('maxBitmapBytes must be a positive safe integer');
		this.windowSeconds = windowSeconds;
		const windowNanoseconds = Math.round(windowSeconds * 1_000_000_000);
		if (!Number.isSafeInteger(windowNanoseconds) || windowNanoseconds < 1)
			throw new RangeError('window nanoseconds must be positive and safe');
		this.windowNs = BigInt(windowNanoseconds);
		this.bounds = {...bounds};
		this.maxBitmapBytes = maxBitmapBytes;
		this.actors = [];
		this.actorIndex = new Map();
		this.expectedByChannel = new Map();
		this.expectedByCohortChannel = new Map();
		for (const input of actors) {
			if (input?.id === undefined || input?.id === null) throw new TypeError('actor id is required');
			const id = scalarId(input.id);
			if (this.actorIndex.has(id)) throw new Error('duplicate actor ownership: ' + id);
			const cohorts = [
				...new Set((Array.isArray(input.cohort) ? input.cohort : [input.cohort]).filter(Boolean).map(String)),
			];
			if (!cohorts.length) throw new TypeError('actor must have at least one cohort: ' + id);
			const channelIds = [...new Set((input.channelIds || []).map(scalarId))];
			const index = this.actors.length;
			this.actorIndex.set(id, index);
			this.actors.push({id, cohorts, channelIds});
			for (const channelId of channelIds) {
				if (!this.expectedByChannel.has(channelId)) this.expectedByChannel.set(channelId, []);
				this.expectedByChannel.get(channelId).push(index);
				for (const cohort of cohorts) {
					const key = cohort + '\u0000' + channelId;
					if (!this.expectedByCohortChannel.has(key)) this.expectedByCohortChannel.set(key, []);
					this.expectedByCohortChannel.get(key).push(index);
				}
			}
		}
		if ((messages === undefined) === (plan === undefined))
			throw new TypeError('provide exactly one of messages or compressed plan');
		this.plan = plan ? this.#normalizePlan(plan) : null;
		this.explicitMessages = messages ? this.#normalizeMessages(messages) : null;
		this.messageBySequence = this.explicitMessages
			? new Map(this.explicitMessages.map((message) => [message.sequence, message]))
			: null;
		this.stageMessages = this.explicitMessages ? this.explicitMessages.filter((message) => message.inStage) : null;
		this.stageRowBySequence = this.stageMessages
			? new Map(this.stageMessages.map((message, index) => [message.sequence, index]))
			: null;
		this.messageCount = this.plan ? this.plan.count : this.explicitMessages.length;
		const stageCount = this.plan ? this.plan.stageCount : this.stageMessages.length;
		const bitCount = BigInt(stageCount) * BigInt(this.actors.length);
		const bitmapBytes = (bitCount + 7n) / 8n;
		if (bitmapBytes > BigInt(this.maxBitmapBytes) || bitmapBytes > BigInt(bufferConstants.MAX_LENGTH)) {
			throw new RangeError('delivery bitmap exceeds configured hard memory limit');
		}
		this.bitmap = Buffer.alloc(Number(bitmapBytes));
		this.bitmapBytes = Number(bitmapBytes);
		this.messageState = new Map();
		this.metrics = this.#newMetrics();
		this.tailMetrics = this.#newMetrics();
		this.deltaMetrics = this.#newMetrics();
		this.deltaTailMetrics = this.#newMetrics();
		this.counters = this.#newCounters();
		this.deltaCounters = this.#newCounters();
		this.workerSeq = 0;
		this.finalSnapshot = null;
		this.expectedTotals = this.#computeExpectedTotals();
		this.actorManifest = this.actors.map((actor) => ({
			...actor,
			channelIds: [...actor.channelIds].sort(),
			cohorts: [...actor.cohorts].sort(),
		}));
		this.actorManifestSha256 = checksumJson(this.actorManifest);
		this.planSha256 = checksumJson(this.#planIdentity());
	}

	/** 规范化压缩的连续sequence、匀速时钟和round-robin频道计划。 */
	#normalizePlan(plan) {
		const sequenceStart = BigInt(sequenceKey(plan.sequenceStart));
		const sequenceEnd = BigInt(sequenceKey(plan.sequenceEnd));
		const scheduledStartNs = monoNs(plan.scheduledStartNs, 'plan.scheduledStartNs');
		const intervalNs = monoNs(plan.intervalNs, 'plan.intervalNs');
		const channelIds = [...new Set((plan.channelIds || []).map(scalarId))];
		if (sequenceEnd <= sequenceStart || intervalNs <= 0n || !channelIds.length)
			throw new RangeError('invalid compressed message plan');
		const count = sequenceEnd - sequenceStart;
		if (count > BigInt(Number.MAX_SAFE_INTEGER))
			throw new RangeError('compressed plan has too many messages to index safely');
		let firstOffset = (this.startNs - scheduledStartNs + intervalNs - 1n) / intervalNs;
		let endOffset = (this.endNs - scheduledStartNs + intervalNs - 1n) / intervalNs;
		if (firstOffset < 0n) firstOffset = 0n;
		if (endOffset < 0n) endOffset = 0n;
		if (firstOffset > count) firstOffset = count;
		if (endOffset > count) endOffset = count;
		if (endOffset < firstOffset) endOffset = firstOffset;
		return {
			sequenceStart,
			sequenceEnd,
			scheduledStartNs,
			intervalNs,
			channelIds,
			count: Number(count),
			firstOffset: Number(firstOffset),
			endOffset: Number(endOffset),
			stageCount: Number(endOffset - firstOffset),
		};
	}

	/** 规范化显式消息计划，并把formal end严格作为排除边界。 */
	#normalizeMessages(messages) {
		if (!Array.isArray(messages)) throw new TypeError('messages must be an array');
		const seen = new Set();
		return messages
			.map((input) => {
				const sequence = sequenceKey(input.sequence);
				if (seen.has(sequence)) throw new Error('duplicate planned sequence: ' + sequence);
				seen.add(sequence);
				const scheduledMonoNs = monoNs(input.scheduledMonoNs, 'scheduledMonoNs');
				return {
					sequence,
					channelId: scalarId(input.channelId),
					scheduledMonoNs,
					messageId: input.messageId == null ? null : scalarId(input.messageId),
					inStage: scheduledMonoNs >= this.startNs && scheduledMonoNs < this.endNs,
				};
			})
			.sort((a, b) => compareSequence(a.sequence, b.sequence));
	}

	/** 生成显式或压缩计划的稳定身份，用于跨worker一致性校验。 */
	#planIdentity() {
		if (this.plan)
			return {
				kind: 'compressed-round-robin',
				sequenceStart: this.plan.sequenceStart.toString(),
				sequenceEnd: this.plan.sequenceEnd.toString(),
				scheduledStartNs: this.plan.scheduledStartNs.toString(),
				intervalNs: this.plan.intervalNs.toString(),
				channelIds: this.plan.channelIds,
				formalStartNs: this.startNs.toString(),
				formalEndNs: this.endNs.toString(),
				drainEndNs: this.drainEndNs.toString(),
			};
		return {
			kind: 'explicit',
			messages: this.explicitMessages.map((message) => ({
				sequence: message.sequence,
				channelId: message.channelId,
				scheduledMonoNs: message.scheduledMonoNs.toString(),
				messageId: message.messageId,
				inStage: message.inStage,
			})),
			formalStartNs: this.startNs.toString(),
			formalEndNs: this.endNs.toString(),
			drainEndNs: this.drainEndNs.toString(),
		};
	}

	/** 为plan或显式消息统一解析频道、计划时间和位图行。 */
	#getMessage(sequence) {
		if (this.plan) {
			const seq = BigInt(sequence);
			if (seq < this.plan.sequenceStart || seq >= this.plan.sequenceEnd) return null;
			const offset = Number(seq - this.plan.sequenceStart);
			const scheduledMonoNs = this.plan.scheduledStartNs + BigInt(offset) * this.plan.intervalNs;
			const channelId = this.plan.channelIds[offset % this.plan.channelIds.length];
			const inStage =
				offset >= this.plan.firstOffset &&
				offset < this.plan.endOffset &&
				scheduledMonoNs >= this.startNs &&
				scheduledMonoNs < this.endNs;
			return {
				sequence,
				channelId,
				scheduledMonoNs,
				messageId: null,
				inStage,
				bitmapRow: inStage ? offset - this.plan.firstOffset : -1,
			};
		}
		const message = this.messageBySequence.get(sequence);
		if (!message) return null;
		if (!message.inStage) return {...message, bitmapRow: -1};
		const row = this.stageRowBySequence.get(sequence);
		return {...message, bitmapRow: row};
	}

	/** 返回已处于stage的消息索引，供分页finalize和expected计算使用。 */
	#getStageMessage(index) {
		if (
			!Number.isSafeInteger(index) ||
			index < 0 ||
			index >= (this.plan ? this.plan.stageCount : this.stageMessages.length)
		)
			return null;
		if (this.plan) {
			const offset = this.plan.firstOffset + index;
			const sequence = (this.plan.sequenceStart + BigInt(offset)).toString();
			return this.#getMessage(sequence);
		}
		return {...this.stageMessages[index], bitmapRow: index};
	}

	/** 汇总总量、分cohort和按scheduled时间切分的延迟指标。 */
	#newMetrics() {
		return {all: emptyLatency(), cohorts: new Map(), windows: new Map()};
	}

	/** 创建所有需要计数的审计分类字段。 */
	#newCounters() {
		return {
			accepted: 0,
			qualityUnique: 0,
			formalUnique: 0,
			tailUnique: 0,
			preFormalUnique: 0,
			duplicate: 0,
			unexpected: 0,
			wrongChannel: 0,
			unknownActor: 0,
			unplanned: 0,
			outsideStage: 0,
			outsideDrain: 0,
			invalidTimestamp: 0,
			submissionMismatch: 0,
			lateSubmissions: 0,
		};
	}

	/** 创建某个cohort、window的延迟桶并保持不超过实际出现的标签数。 */
	#metricFor(metrics, cohort, windowId, windowStartNs, windowEndNs) {
		if (!metrics.cohorts.has(cohort)) metrics.cohorts.set(cohort, emptyLatency());
		const key = String(windowId);
		if (!metrics.windows.has(key))
			metrics.windows.set(key, {windowId, startNs: windowStartNs, endNs: windowEndNs, cohorts: new Map()});
		const window = metrics.windows.get(key);
		if (!window.cohorts.has(cohort)) window.cohorts.set(cohort, emptyLatency());
		return [metrics.cohorts.get(cohort), window.cohorts.get(cohort)];
	}

	/** 更新全局、cohort和scheduled-window的延迟分布。 */
	#recordLatency(metrics, actor, receivedNs, latencyNs, includeWindow = true) {
		addLatency(metrics.all, latencyNs);
		for (const cohort of actor.cohorts) {
			if (!metrics.cohorts.has(cohort)) metrics.cohorts.set(cohort, emptyLatency());
			addLatency(metrics.cohorts.get(cohort), latencyNs);
			if (includeWindow) {
				const offset = receivedNs - this.startNs;
				const windowId = Number(offset / this.windowNs);
				const windowStartNs = this.startNs + BigInt(windowId) * this.windowNs;
				const windowEndNs = windowStartNs + this.windowNs < this.endNs ? windowStartNs + this.windowNs : this.endNs;
				const [, byWindow] = this.#metricFor(metrics, cohort, windowId, windowStartNs, windowEndNs);
				addLatency(byWindow, latencyNs);
			}
		}
	}

	/** 按频道计算expected总数和cohort重叠视图。 */
	#computeExpectedTotals() {
		const byCohort = {};
		let total = 0;
		const add = (channelId, amount) => {
			const ids = this.expectedByChannel.get(channelId) || [];
			total += ids.length * amount;
			for (const actorIndex of ids)
				for (const cohort of this.actors[actorIndex].cohorts) byCohort[cohort] = (byCohort[cohort] || 0) + amount;
		};
		if (this.plan) {
			for (let i = 0; i < this.plan.stageCount; i += 1) {
				const message = this.#getStageMessage(i);
				add(message.channelId, 1);
			}
		} else {
			for (const message of this.explicitMessages) if (message.inStage) add(message.channelId, 1);
		}
		return {total, byCohort};
	}

	/** 质量位图覆盖正式窗与合法排空；性能窗只统计实际正式窗接收。 */
	record({actorId, sequence, channelId, messageId, submitMonoNs, receivedMonoNs}) {
		if (this.finalSnapshot) throw new Error('audit is finalized');
		let seq;
		try {
			actorId = scalarId(actorId);
			channelId = scalarId(channelId);
			if (messageId != null) messageId = scalarId(messageId);
			seq = sequenceKey(sequence);
		} catch {
			return this.#reject('unplanned');
		}
		const message = this.#getMessage(seq);
		if (!message) return this.#reject('unplanned');
		if (!message.inStage) return this.#reject('outsideStage', message);
		const actorIndex = this.actorIndex.get(String(actorId));
		if (actorIndex === undefined) return this.#reject('unknownActor', message);
		if (String(channelId) !== message.channelId) return this.#reject('wrongChannel', message);
		const actor = this.actors[actorIndex];
		if (!actor.channelIds.includes(message.channelId)) return this.#reject('unexpected', message);
		let submit;
		let received;
		try {
			submit = monoNs(submitMonoNs, 'submitMonoNs');
			received = monoNs(receivedMonoNs, 'receivedMonoNs');
		} catch {
			return this.#reject('invalidTimestamp', message);
		}
		if (submit >= this.drainEndNs || received >= this.drainEndNs) return this.#reject('outsideDrain', message);
		if (received < submit) return this.#reject('invalidTimestamp', message);
		const state = this.#stateFor(message);
		if (state.submitMonoNs !== null && state.submitMonoNs !== submit)
			return this.#reject('submissionMismatch', message);
		state.submitMonoNs = submit;
		if (message.messageId && String(messageId) !== message.messageId) return this.#reject('unexpected', message);
		if (state.messageId !== null && String(messageId) !== state.messageId) return this.#reject('unexpected', message);
		if (state.messageId === null && messageId != null) state.messageId = String(messageId);
		const bitIndex = message.bitmapRow * this.actors.length + actorIndex;
		const byteIndex = Math.floor(bitIndex / 8);
		const mask = 1 << (bitIndex & 7);
		if (this.bitmap[byteIndex] & mask) return this.#reject('duplicate', message);
		this.bitmap[byteIndex] |= mask;
		const latencyNs = received - submit;
		state.actual += 1;
		state.minLatencyNs = state.minLatencyNs === null || latencyNs < state.minLatencyNs ? latencyNs : state.minLatencyNs;
		state.maxLatencyNs = state.maxLatencyNs === null || latencyNs > state.maxLatencyNs ? latencyNs : state.maxLatencyNs;
		state.minReceiveNs = state.minReceiveNs === null || received < state.minReceiveNs ? received : state.minReceiveNs;
		state.maxReceiveNs = state.maxReceiveNs === null || received > state.maxReceiveNs ? received : state.maxReceiveNs;
		state.lastReceiveNs =
			state.lastReceiveNs === null || received > state.lastReceiveNs ? received : state.lastReceiveNs;
		this.counters.accepted += 1;
		this.counters.qualityUnique += 1;
		this.deltaCounters.accepted += 1;
		this.deltaCounters.qualityUnique += 1;
		let formalAccepted = false;
		let tailAccepted = false;
		if (received >= this.startNs && received < this.endNs) {
			formalAccepted = true;
			state.formalActual = (state.formalActual || 0) + 1;
			state.formalMinLatencyNs =
				state.formalMinLatencyNs === undefined ||
				state.formalMinLatencyNs === null ||
				latencyNs < state.formalMinLatencyNs
					? latencyNs
					: state.formalMinLatencyNs;
			state.formalMaxLatencyNs =
				state.formalMaxLatencyNs === undefined ||
				state.formalMaxLatencyNs === null ||
				latencyNs > state.formalMaxLatencyNs
					? latencyNs
					: state.formalMaxLatencyNs;
			this.counters.formalUnique += 1;
			this.deltaCounters.formalUnique += 1;
			this.#recordLatency(this.metrics, actor, received, latencyNs);
			this.#recordLatency(this.deltaMetrics, actor, received, latencyNs);
		} else if (received >= this.endNs) {
			tailAccepted = true;
			state.tailActual = (state.tailActual || 0) + 1;
			state.tailMinLatencyNs =
				state.tailMinLatencyNs === undefined || state.tailMinLatencyNs === null || latencyNs < state.tailMinLatencyNs
					? latencyNs
					: state.tailMinLatencyNs;
			state.tailMaxLatencyNs =
				state.tailMaxLatencyNs === undefined || state.tailMaxLatencyNs === null || latencyNs > state.tailMaxLatencyNs
					? latencyNs
					: state.tailMaxLatencyNs;
			this.counters.tailUnique += 1;
			this.deltaCounters.tailUnique += 1;
			this.#recordLatency(this.tailMetrics, actor, received, latencyNs, false);
			this.#recordLatency(this.deltaTailMetrics, actor, received, latencyNs, false);
		} else {
			this.counters.preFormalUnique += 1;
			this.deltaCounters.preFormalUnique += 1;
		}
		const late = submit > message.scheduledMonoNs;
		if (late && !state.lateSubmissionCounted) {
			this.counters.lateSubmissions += 1;
			this.deltaCounters.lateSubmissions += 1;
			state.lateSubmissionCounted = true;
		}
		return {
			accepted: true,
			qualityAccepted: true,
			formalAccepted,
			tailAccepted,
			code: 'accepted',
			late,
			latencyMs: Number(latencyNs) / Number(NS_PER_MS),
		};
	}

	/** 记录拒绝分类并保留每消息的错误计数，不增加unique位图。 */
	#reject(code, message = null) {
		this.counters[code] = (this.counters[code] || 0) + 1;
		this.deltaCounters[code] = (this.deltaCounters[code] || 0) + 1;
		if (message) {
			const state = this.#stateFor(message);
			state[code] = (state[code] || 0) + 1;
		}
		return {accepted: false, code, late: false};
	}

	/** 创建某消息稀疏状态，未观察消息不分配对象或日志行。 */
	#stateFor(message) {
		if (!this.messageState.has(message.sequence))
			this.messageState.set(message.sequence, {
				actual: 0,
				formalActual: 0,
				tailActual: 0,
				submitMonoNs: null,
				messageId: null,
				minLatencyNs: null,
				maxLatencyNs: null,
				minReceiveNs: null,
				maxReceiveNs: null,
				lastReceiveNs: null,
				lateSubmissionCounted: false,
			});
		return this.messageState.get(message.sequence);
	}

	/** 保留正式窗或合法排空中的实际发送时间和调度lag。 */
	recordSubmission({sequence, submitMonoNs}) {
		if (this.finalSnapshot) throw new Error('audit is finalized');
		let seq;
		try {
			seq = sequenceKey(sequence);
		} catch {
			return this.#reject('unplanned');
		}
		const message = this.#getMessage(seq);
		if (!message) return this.#reject('unplanned');
		if (!message.inStage) return this.#reject('outsideStage', message);
		let submit;
		try {
			submit = monoNs(submitMonoNs, 'submitMonoNs');
		} catch {
			return this.#reject('invalidTimestamp', message);
		}
		if (submit >= this.drainEndNs) return this.#reject('outsideDrain', message);
		const state = this.#stateFor(message);
		if (state.submitMonoNs !== null && state.submitMonoNs !== submit)
			return this.#reject('submissionMismatch', message);
		if (state.submitMonoNs === submit)
			return {accepted: true, code: 'submitted', late: submit > message.scheduledMonoNs, duplicateSubmission: true};
		state.submitMonoNs = submit;
		const late = submit > message.scheduledMonoNs;
		if (late && !state.lateSubmissionCounted) {
			this.counters.lateSubmissions += 1;
			this.deltaCounters.lateSubmissions += 1;
			state.lateSubmissionCounted = true;
		}
		return {accepted: true, code: 'submitted', late};
	}

	/** 生成不包含位图和逐事件记录的累计worker快照。 */
	snapshot() {
		return this.#snapshotSummary(false);
	}

	/** 输出可幂等消费的增量摘要，序号连续且不携带actor矩阵。 */
	deltaSnapshot() {
		if (this.finalSnapshot) throw new Error('audit is finalized');
		const baseSeq = this.workerSeq;
		this.workerSeq += 1;
		const payload = {
			schema: SCHEMA,
			runHash: this.runHash,
			workerId: this.workerId,
			stageId: this.stageId,
			workerSeq: this.workerSeq,
			baseSeq,
			cumulative: false,
			formalStartNs: this.startNs.toString(),
			formalEndNs: this.endNs.toString(),
			drainEndNs: this.drainEndNs.toString(),
			counters: {...this.deltaCounters},
			qualityUnique: this.deltaCounters.qualityUnique,
			formalUnique: this.deltaCounters.formalUnique,
			tailUnique: this.deltaCounters.tailUnique,
			latency: this.#metricsJson(this.deltaMetrics),
			tailLatency: this.#metricsJson(this.deltaTailMetrics),
		};
		payload.checksum = checksumJson(payload);
		this.deltaCounters = this.#newCounters();
		this.deltaMetrics = this.#newMetrics();
		this.deltaTailMetrics = this.#newMetrics();
		return payload;
	}

	/** 对已结束投递阶段输出非封存快照，继续捕获跨级迟到或重复事件。 */
	checkpoint({cursor = 0, limit = DEFAULT_PAGE_SIZE, missingSampleLimit = DEFAULT_MISSING_SAMPLE} = {}) {
		if (this.finalSnapshot) return this.finalize({cursor, limit, missingSampleLimit});
		if (
			!Number.isSafeInteger(cursor) ||
			cursor < 0 ||
			!Number.isSafeInteger(limit) ||
			limit <= 0 ||
			!Number.isSafeInteger(missingSampleLimit) ||
			missingSampleLimit < 0 ||
			missingSampleLimit > 64
		)
			throw new RangeError('invalid completed-stage checkpoint page');
		const totalMessages = this.plan ? this.plan.stageCount : this.stageMessages.length;
		if (cursor > totalMessages) throw new RangeError('checkpoint cursor exceeds planned stage');
		const count = Math.min(limit, totalMessages - cursor),
			messages = [];
		for (let index = cursor; index < cursor + count; index++)
			messages.push(this.#messageSummary(this.#getStageMessage(index), missingSampleLimit));
		this.checkpointed = true;
		return {
			...this.#snapshotSummary(false),
			checkpointSnapshot: true,
			completedStageObservationStillOpen: true,
			bitmap: {encoding: 'dense-bit-per-sequence-actor', byteLength: this.bitmap.length, sha256: sha256(this.bitmap)},
			perMessagePage: {
				cursor,
				limit,
				count,
				totalMessages,
				nextCursor: cursor + count < totalMessages ? cursor + count : null,
				missingTotal: this.expectedTotals.total - this.counters.accepted,
				messages,
			},
		};
	}

	/** 關閉收集並輸出可分页消息闭合、缺失样本和位图证明。 */
	finalize({cursor = 0, limit = DEFAULT_PAGE_SIZE, missingSampleLimit = DEFAULT_MISSING_SAMPLE} = {}) {
		if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit <= 0)
			throw new RangeError('invalid finalize page');
		if (!Number.isSafeInteger(missingSampleLimit) || missingSampleLimit < 0 || missingSampleLimit > 64)
			throw new RangeError('missingSampleLimit must be between 0 and 64');
		const totalMessages = this.plan ? this.plan.stageCount : this.stageMessages.length;
		if (cursor > totalMessages) throw new RangeError('finalize cursor exceeds planned stage messages');
		if (!this.finalSnapshot) {
			this.workerSeq += 1;
			this.finalSnapshot = this.#snapshotSummary(true);
			this.finalSnapshot.workerSeq = this.workerSeq;
			this.finalSnapshot.bitmap = {
				encoding: 'dense-bit-per-sequence-actor',
				byteLength: this.bitmap.length,
				sha256: sha256(this.bitmap),
			};
		}
		const count = Math.min(limit, totalMessages - cursor);
		const perMessage = [];
		for (let i = cursor; i < cursor + count; i += 1)
			perMessage.push(this.#messageSummary(this.#getStageMessage(i), missingSampleLimit));
		const missingTotal = this.expectedTotals.total - this.counters.accepted;
		return {
			...this.finalSnapshot,
			perMessagePage: {
				cursor,
				limit,
				count,
				totalMessages,
				nextCursor: cursor + count < totalMessages ? cursor + count : null,
				missingTotal,
				messages: perMessage,
			},
		};
	}

	/** 将精确位图提供给文件写入器，避免在JSON里展开投递矩阵。 */
	exportBitmap() {
		return Buffer.from(this.bitmap);
	}

	/** 返回不带位图的汇总或final metadata。 */
	#snapshotSummary(finalized) {
		return {
			schema: SCHEMA,
			runHash: this.runHash,
			workerId: this.workerId,
			stageId: this.stageId,
			workerSeq: this.workerSeq,
			cumulative: true,
			finalized,
			formalStartNs: this.startNs.toString(),
			formalEndNs: this.endNs.toString(),
			drainEndNs: this.drainEndNs.toString(),
			windowSeconds: this.windowSeconds,
			bounds: this.bounds,
			actorIds: this.actors.map((actor) => actor.id),
			actorManifestSha256: this.actorManifestSha256,
			planSha256: this.planSha256,
			plannedMessages: this.plan ? this.plan.stageCount : this.stageMessages.length,
			expectedUnique: this.expectedTotals.total,
			actualUnique: this.counters.qualityUnique,
			qualityUnique: this.counters.qualityUnique,
			formalUnique: this.counters.formalUnique,
			tailUnique: this.counters.tailUnique,
			preFormalUnique: this.counters.preFormalUnique,
			missingUnique: this.expectedTotals.total - this.counters.qualityUnique,
			expectedByCohort: this.expectedTotals.byCohort,
			counters: {...this.counters},
			latency: this.#metricsJson(this.metrics),
			tailLatency: this.#metricsJson(this.tailMetrics),
		};
	}

	/** 把稀疏map转成排序后的JSON结构，保留各分位桶可合并性。 */
	#metricsJson(metrics) {
		const cohorts = Object.fromEntries(
			[...metrics.cohorts.entries()]
				.sort((a, b) => a[0].localeCompare(b[0]))
				.map(([key, value]) => [key, latencySummary(value)]),
		);
		const windows = [...metrics.windows.values()]
			.sort((a, b) => a.windowId - b.windowId)
			.map((window) => ({
				windowId: window.windowId,
				startNs: window.startNs.toString(),
				endNs: window.endNs.toString(),
				cohorts: Object.fromEntries(
					[...window.cohorts.entries()]
						.sort((a, b) => a[0].localeCompare(b[0]))
						.map(([key, value]) => [key, latencySummary(value)]),
				),
			}));
		return {all: latencySummary(metrics.all), cohorts, windows};
	}

	/** 返回频道的expected actor index集合。 */
	#expectedActors(channelId) {
		return this.expectedByChannel.get(channelId) || [];
	}

	/** 生成紧凑的单消息闭合记录和有界缺失actor样本。 */
	#messageSummary(message, missingSampleLimit) {
		const expected = this.#expectedActors(message.channelId);
		const state = this.messageState.get(message.sequence) || {actual: 0};
		const missingActorSample = [];
		for (const actorIndex of expected) {
			if (missingActorSample.length >= missingSampleLimit) break;
			const bit = message.bitmapRow * this.actors.length + actorIndex;
			if ((this.bitmap[bit >> 3] & (1 << (bit & 7))) === 0) missingActorSample.push(this.actors[actorIndex].id);
		}
		const scheduleLagNs =
			state.submitMonoNs === undefined || state.submitMonoNs === null
				? null
				: (state.submitMonoNs - message.scheduledMonoNs).toString();
		return {
			sequence: message.sequence,
			channelId: message.channelId,
			scheduledMonoNs: message.scheduledMonoNs.toString(),
			messageId: state.messageId ?? message.messageId ?? null,
			expected: expected.length,
			actualUnique: state.actual || 0,
			qualityUnique: state.actual || 0,
			formalUnique: state.formalActual || 0,
			tailUnique: state.tailActual || 0,
			missing: expected.length - (state.actual || 0),
			submitMonoNs: state.submitMonoNs == null ? null : state.submitMonoNs.toString(),
			scheduleLagNs,
			minLatencyNs: state.minLatencyNs?.toString() ?? null,
			maxLatencyNs: state.maxLatencyNs?.toString() ?? null,
			formalMinLatencyNs: state.formalMinLatencyNs?.toString() ?? null,
			formalMaxLatencyNs: state.formalMaxLatencyNs?.toString() ?? null,
			tailMinLatencyNs: state.tailMinLatencyNs?.toString() ?? null,
			tailMaxLatencyNs: state.tailMaxLatencyNs?.toString() ?? null,
			minReceiveNs: state.minReceiveNs?.toString() ?? null,
			maxReceiveNs: state.maxReceiveNs?.toString() ?? null,
			lastReceiveNs: state.lastReceiveNs?.toString() ?? null,
			duplicate: state.duplicate || 0,
			unexpected: state.unexpected || 0,
			wrongChannel: state.wrongChannel || 0,
			unknownActor: state.unknownActor || 0,
			outsideStage: state.outsideStage || 0,
			outsideDrain: state.outsideDrain || 0,
			invalidTimestamp: state.invalidTimestamp || 0,
			submissionMismatch: state.submissionMismatch || 0,
			missingActorSample,
		};
	}
}

/** 合并多个worker final，按去重hist桶计数重算整体p95。 */
export function mergeSnapshots(
	snapshots,
	{bitmapDataByWorker = null, expectedWorkerIds, expectedActorIds, allowCheckpoints = false} = {},
) {
	if (!Array.isArray(snapshots) || snapshots.length === 0) throw new TypeError('snapshots must be a non-empty array');
	const normalizeExpectedSet = (values, label) => {
		if (!Array.isArray(values) || values.length === 0) throw new TypeError(label + ' must be a non-empty array');
		const normalized = values.map(scalarId);
		if (normalized.some((value) => !value) || new Set(normalized).size !== normalized.length)
			throw new Error(label + ' must contain unique non-empty IDs');
		return new Set(normalized);
	};
	const expectedWorkers = normalizeExpectedSet(expectedWorkerIds, 'expectedWorkerIds');
	const expectedActors = normalizeExpectedSet(expectedActorIds, 'expectedActorIds');
	const first = snapshots[0];
	const snapshotKind = first.finalized === true ? 'final' : 'preview';
	if (snapshotKind === 'preview' && !allowCheckpoints)
		throw new Error('preview snapshots require explicit allowCheckpoints');
	const workerIds = new Set();
	const actorIds = new Set();
	const aggregate = {
		counters: {},
		expectedUnique: 0,
		expectedByCohort: {},
		latency: {all: emptyLatency(), cohorts: new Map(), windows: new Map()},
		tailLatency: {all: emptyLatency(), cohorts: new Map(), windows: new Map()},
		plannedMessages: first.plannedMessages,
	};
	for (const snapshot of snapshots) {
		if (snapshot.schema !== SCHEMA || !snapshot.cumulative || (!snapshot.finalized && !snapshot.checkpointSnapshot))
			throw new Error('merge requires finalized cumulative DeliveryAudit snapshots');
		if ((snapshot.finalized === true ? 'final' : 'preview') !== snapshotKind)
			throw new Error('cannot mix preview and final snapshots');
		if (workerIds.has(snapshot.workerId)) throw new Error('duplicate workerId: ' + snapshot.workerId);
		workerIds.add(snapshot.workerId);
		for (const field of [
			'runHash',
			'stageId',
			'formalStartNs',
			'formalEndNs',
			'drainEndNs',
			'windowSeconds',
			'planSha256',
			'plannedMessages',
		])
			if (snapshot[field] !== first[field]) throw new Error('incompatible snapshot ' + field);
		for (const id of snapshot.actorIds) {
			if (actorIds.has(id)) throw new Error('actor owned by multiple workers: ' + id);
			actorIds.add(id);
		}
		if (
			!snapshot.bitmap ||
			!Number.isSafeInteger(snapshot.bitmap.byteLength) ||
			!/^[a-f0-9]{64}$/.test(snapshot.bitmap.sha256)
		)
			throw new Error('invalid bitmap proof for ' + snapshot.workerId);
		if (bitmapDataByWorker) {
			const bytes =
				bitmapDataByWorker instanceof Map
					? bitmapDataByWorker.get(snapshot.workerId)
					: bitmapDataByWorker[snapshot.workerId];
			if (!bytes || bytes.length !== snapshot.bitmap.byteLength || sha256(bytes) !== snapshot.bitmap.sha256)
				throw new Error('bitmap proof mismatch for ' + snapshot.workerId);
		}
		// 原始位图存在时重新计数，不能用计划扇出或可编辑摘要冒充唯一实收。
		if (bitmapDataByWorker) {
			const bytes =
				bitmapDataByWorker instanceof Map
					? bitmapDataByWorker.get(snapshot.workerId)
					: bitmapDataByWorker[snapshot.workerId];
			let actualBits = 0;
			for (const byte of bytes) {
				let remaining = byte;
				while (remaining) {
					remaining &= remaining - 1;
					actualBits++;
				}
			}
			if (actualBits !== snapshot.actualUnique || actualBits !== snapshot.counters.qualityUnique) {
				throw new Error('bitmap actual receipt count differs from summary');
			}
		}
		if (
			!Number.isSafeInteger(snapshot.actualUnique) ||
			snapshot.actualUnique !== snapshot.counters.qualityUnique ||
			!Number.isSafeInteger(snapshot.expectedUnique) ||
			snapshot.expectedUnique < 0 ||
			snapshot.actualUnique > snapshot.expectedUnique ||
			Object.values(snapshot.counters).some((count) => !Number.isSafeInteger(count) || count < 0)
		) {
			throw new Error('invalid delivery counter');
		}
		for (const [key, value] of Object.entries(snapshot.counters)) {
			const total = (aggregate.counters[key] || 0) + value;
			if (!Number.isSafeInteger(total)) throw new Error('aggregate counter exceeds safe integer');
			aggregate.counters[key] = total;
		}
		aggregate.expectedUnique += snapshot.expectedUnique;
		if (!Number.isSafeInteger(aggregate.expectedUnique))
			throw new Error('aggregate expected count exceeds safe integer');
		for (const [key, value] of Object.entries(snapshot.expectedByCohort))
			aggregate.expectedByCohort[key] = (aggregate.expectedByCohort[key] || 0) + value;
		mergeLatencyMetric(aggregate.latency.all, snapshot.latency.all);
		mergeLatencyMetric(aggregate.tailLatency.all, snapshot.tailLatency.all);
		for (const [cohort, metric] of Object.entries(snapshot.latency.cohorts)) {
			if (!aggregate.latency.cohorts.has(cohort)) aggregate.latency.cohorts.set(cohort, emptyLatency());
			mergeLatencyMetric(aggregate.latency.cohorts.get(cohort), metric);
		}
		for (const [cohort, metric] of Object.entries(snapshot.tailLatency.cohorts)) {
			if (!aggregate.tailLatency.cohorts.has(cohort)) aggregate.tailLatency.cohorts.set(cohort, emptyLatency());
			mergeLatencyMetric(aggregate.tailLatency.cohorts.get(cohort), metric);
		}
		for (const window of snapshot.latency.windows) {
			const key = String(window.windowId);
			if (!aggregate.latency.windows.has(key))
				aggregate.latency.windows.set(key, {
					windowId: window.windowId,
					startNs: BigInt(window.startNs),
					endNs: BigInt(window.endNs),
					cohorts: new Map(),
				});
			const target = aggregate.latency.windows.get(key);
			if (target.startNs.toString() !== window.startNs || target.endNs.toString() !== window.endNs)
				throw new Error('window bounds mismatch');
			for (const [cohort, metric] of Object.entries(window.cohorts)) {
				if (!target.cohorts.has(cohort)) target.cohorts.set(cohort, emptyLatency());
				mergeLatencyMetric(target.cohorts.get(cohort), metric);
			}
		}
	}
	if (workerIds.size !== expectedWorkers.size || [...expectedWorkers].some((id) => !workerIds.has(id)))
		throw new Error('worker snapshot coverage differs from expectedWorkerIds');
	if (actorIds.size !== expectedActors.size || [...expectedActors].some((id) => !actorIds.has(id)))
		throw new Error('actor snapshot coverage differs from expectedActorIds');
	const latency = metricsToJson(aggregate.latency);
	const tailLatency = metricsToJson(aggregate.tailLatency);
	return {
		schema: SCHEMA,
		snapshotKind,
		runHash: first.runHash,
		stageId: first.stageId,
		formalStartNs: first.formalStartNs,
		formalEndNs: first.formalEndNs,
		drainEndNs: first.drainEndNs,
		windowSeconds: first.windowSeconds,
		workerIds: [...workerIds].sort(),
		expectedWorkerIds: [...expectedWorkers].sort(),
		actorIds: [...actorIds].sort(),
		expectedActorIds: [...expectedActors].sort(),
		actorCoverageVerified: true,
		actorCount: actorIds.size,
		plannedMessages: first.plannedMessages,
		expectedUnique: aggregate.expectedUnique,
		actualUnique: aggregate.counters.qualityUnique || 0,
		qualityUnique: aggregate.counters.qualityUnique || 0,
		formalUnique: aggregate.counters.formalUnique || 0,
		tailUnique: aggregate.counters.tailUnique || 0,
		preFormalUnique: aggregate.counters.preFormalUnique || 0,
		missingUnique: aggregate.expectedUnique - (aggregate.counters.qualityUnique || 0),
		expectedByCohort: aggregate.expectedByCohort,
		counters: aggregate.counters,
		latency,
		tailLatency,
		bitmapProofs: snapshots.map((s) => ({workerId: s.workerId, ...s.bitmap})),
		bitmapDataVerified: Boolean(bitmapDataByWorker),
	};
}

/** 把JSON histogram精确合并到内部直方图，分位数稍后统一重算。 */
function mergeLatencyMetric(target, source) {
	target.count += source.count;
	target.sumNs += BigInt(source.sumNs);
	if (source.minNs !== null && (target.minNs === null || BigInt(source.minNs) < target.minNs))
		target.minNs = BigInt(source.minNs);
	if (source.maxNs !== null && (target.maxNs === null || BigInt(source.maxNs) > target.maxNs))
		target.maxNs = BigInt(source.maxNs);
	for (const item of source.histogram.bins)
		target.bins.set(item.index, (target.bins.get(item.index) || 0) + item.count);
}

/** 对合并指标统一生成count、精确矩和重算p95结果。 */
function metricsToJson(metrics) {
	const windows = [...metrics.windows.values()]
		.sort((a, b) => a.windowId - b.windowId)
		.map((window) => ({
			windowId: window.windowId,
			startNs: window.startNs.toString(),
			endNs: window.endNs.toString(),
			cohorts: Object.fromEntries(
				[...window.cohorts.entries()]
					.sort((a, b) => a[0].localeCompare(b[0]))
					.map(([key, value]) => [key, latencySummary(value)]),
			),
		}));
	return {
		all: latencySummary(metrics.all),
		cohorts: Object.fromEntries(
			[...metrics.cohorts.entries()]
				.sort((a, b) => a[0].localeCompare(b[0]))
				.map(([key, value]) => [key, latencySummary(value)]),
		),
		windows,
	};
}

export const DELIVERY_AUDIT_SCHEMA = SCHEMA;
