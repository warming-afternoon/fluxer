// SPDX-License-Identifier: AGPL-3.0-or-later
import {generatorIntervalEnvelope} from '../guards/IntervalCoverage.mjs';
import {openResourceLog} from '../guards/ResourceLog.mjs';

/** 精确单调时间必须由同一时钟域提供；远端源时间不参与本地减法。 */
function exact(value) {
	if ((typeof value !== 'bigint' && (typeof value !== 'string' || !/^\d{1,30}$/.test(value))) || BigInt(value) < 0n)
		throw Error('Exact unsigned clock value required');
	return BigInt(value);
}
/** 有界周期观测；失败/缺测始终显式保留，采样覆盖不冒充连续 CPU 覆盖。 */
export function createObservationSession({
	providers,
	intervalMs,
	providerTimeoutMs,
	maxSamples,
	maxSampleBytes,
	maxTotalBytes,
	maxErrors,
	maxGapNs,
	maxAgeNs,
	requiredMetrics,
	clockDomain,
	nowNs = process.hrtime.bigint,
	schedule = setInterval,
	unschedule = clearInterval,
	log,
	limits = {},
	onViolation = async () => {},
}) {
	if (
		!Array.isArray(providers) ||
		!providers.length ||
		providers.length > 32 ||
		new Set(providers.map((p) => p.id)).size !== providers.length ||
		providers.some((p) => typeof p.id !== 'string' || !/^[\w.-]{1,128}$/.test(p.id) || typeof p.read !== 'function')
	)
		throw Error('Bounded uniquely identified providers required');
	for (const [n, cap] of [
		[intervalMs, 60000],
		[providerTimeoutMs, 60000],
		[maxSamples, 100000],
		[maxSampleBytes, 1024 ** 2],
		[maxTotalBytes, 19 * 1024 ** 2],
		[maxErrors, 1000],
	])
		if (!Number.isSafeInteger(n) || n < 1 || n > cap) throw Error('Explicit observation budgets required');
	if (
		!Array.isArray(requiredMetrics) ||
		!requiredMetrics.length ||
		requiredMetrics.length > 128 ||
		new Set(requiredMetrics).size !== requiredMetrics.length ||
		requiredMetrics.some((k) => typeof k !== 'string' || !/^[a-zA-Z][\w.-]{0,127}$/.test(k))
	)
		throw Error('Explicit required metric names required');
	if (
		typeof clockDomain !== 'string' ||
		!clockDomain ||
		clockDomain.length > 128 ||
		exact(maxGapNs) <= 0n ||
		exact(maxAgeNs) <= 0n
	)
		throw Error('Explicit clock domain and freshness bounds required');
	for (const [name, bound] of Object.entries(limits))
		if (!requiredMetrics.includes(name) || !Number.isFinite(bound?.max))
			throw Error('Limits must name required metrics with finite max');
	if (providers.filter((provider) => provider.generatorProcess === true).length > 1)
		throw Error('One physical generator process may not be duplicated across provider IDs');
	let state = null,
		timer = null,
		pending = null;
	const resourceLog = openResourceLog(log);
	const failure = (providerId, code) => {
		state.errorCount++;
		if (state.errors.length < maxErrors) state.errors.push({providerId, code, receivedNs: String(exact(nowNs()))});
	};
	const collect = async () => {
		const seen = new Set();
		const pollTime = exact(nowNs());
		if (state.lastPollNs !== null && pollTime - state.lastPollNs > exact(maxGapNs)) {
			failure('session', 'polling-gap');
			await onViolation({reason: 'polling-gap'});
		}
		state.lastPollNs = pollTime;
		for (const provider of providers) {
			if (state.failedProviders.has(provider.id)) continue;
			const start = exact(nowNs());
			let timeout;
			try {
				const data = await Promise.race([
					Promise.resolve().then(() => provider.read()),
					new Promise((_, reject) => {
						timeout = setTimeout(() => reject(Error('provider deadline')), providerTimeoutMs);
					}),
				]);
				const end = exact(nowNs());
				if (
					end < start ||
					!data ||
					typeof data.metrics !== 'object' ||
					Array.isArray(data.metrics) ||
					Object.keys(data.metrics).length > 128
				)
					throw Error('invalid observation');
				for (const [key, value] of Object.entries(data.metrics))
					if (!/^[a-zA-Z][\w.-]{0,127}$/.test(key) || typeof value !== 'number' || !Number.isFinite(value))
						throw Error('invalid observation metric');
				const row = {
					providerId: provider.id,
					clockDomain,
					receivedStartNs: String(start),
					receivedEndNs: String(end),
					data,
				};
				const bytes = Buffer.byteLength(JSON.stringify(row));
				if (bytes > maxSampleBytes || state.bytes + bytes > maxTotalBytes || state.samples.length >= maxSamples)
					throw Error('observation budget');
				if (resourceLog.enabled && !resourceLog.append(row)) throw Error('observation log budget');
				for (const key of Object.keys(data.metrics)) {
					if (seen.has(key) && requiredMetrics.includes(key)) {
						failure(provider.id, 'ambiguous-metric-owner');
						await onViolation({reason: 'ambiguous-metric-owner', metric: key});
					}
					seen.add(key);
				}
				state.samples.push(row);
				state.bytes += bytes;
				if (Object.keys(data.metrics).some((key) => requiredMetrics.includes(key))) {
					let fresh = false;
					try {
						const source = exact(data.sourceTimestampNs);
						fresh =
							data.sourceIdentityVerified !== false &&
							data.sourceClockDomain === clockDomain &&
							source <= end &&
							end - source <= exact(maxAgeNs);
					} catch {}
					if (!fresh) {
						failure(provider.id, 'source-freshness-unproven');
						await onViolation({providerId: provider.id, reason: 'source-freshness-unproven'});
					}
				}
				for (const [key, bound] of Object.entries(limits))
					if (data.metrics[key] > bound.max) {
						failure(provider.id, 'resource-limit-exceeded');
						await onViolation({providerId: provider.id, metric: key, value: data.metrics[key], max: bound.max});
					}
			} catch {
				state.failedProviders.add(provider.id);
				failure(provider.id, 'sample-unavailable-or-invalid');
				await onViolation({providerId: provider.id, reason: 'observation-unavailable'});
			} finally {
				clearTimeout(timeout);
			}
		}
		const missing = requiredMetrics.filter((key) => !seen.has(key));
		if (missing.length) {
			failure('session', 'required-metric-missing');
			await onViolation({reason: 'required-metric-missing', metrics: missing});
		}
	};
	const sample = () => {
		if (!state || state.closed) return Promise.reject(Error('No active observation stage'));
		if (!pending)
			pending = collect().finally(() => {
				pending = null;
			});
		return pending;
	};
	const finish = async (plan, cancelled) => {
		if (!state || state.closed || plan.stageId !== state.stageId) throw Error('Observation stage identity mismatch');
		unschedule(timer);
		timer = null;
		if (pending) await pending;
		if (!cancelled) await sample();
		for (const provider of providers) {
			try {
				await provider.stop?.();
			} catch {
				failure(provider.id, 'provider-stop-failed');
			}
		}
		state.closed = true;
		const end = exact(nowNs()),
			start = exact(state.startNs);
		const metrics = {},
			owners = new Map();
		for (const row of state.samples)
			for (const [key, value] of Object.entries(row.data.metrics)) {
				const current = (metrics[key] ??= {
					status: 'observed',
					latest: value,
					min: value,
					max: value,
					count: 0,
					firstNs: row.receivedStartNs,
					lastNs: row.receivedEndNs,
					maxGapNs: '0',
				});
				if (owners.has(key) && owners.get(key) !== row.providerId) current.status = 'unknown';
				owners.set(key, row.providerId);
				try {
					if (
						row.data.sourceIdentityVerified === false ||
						row.data.sourceClockDomain !== clockDomain ||
						exact(row.data.sourceTimestampNs) > exact(row.receivedEndNs) ||
						exact(row.receivedEndNs) - exact(row.data.sourceTimestampNs) > exact(maxAgeNs)
					)
						throw Error('unknown freshness');
				} catch {
					current.status = 'unknown';
					current.reason = 'source-freshness-unproven';
				}
				const gap = exact(row.receivedEndNs) - exact(current.lastNs);
				current.maxGapNs = String(gap > exact(current.maxGapNs) ? gap : exact(current.maxGapNs));
				current.latest = value;
				current.min = Math.min(current.min, value);
				current.max = Math.max(current.max, value);
				current.count++;
				current.lastNs = row.receivedEndNs;
			}
		let largest = 0n;
		for (const key of requiredMetrics) {
			const metric = metrics[key];
			if (!metric) {
				metrics[key] = {status: 'unknown', count: 0, reason: 'missing'};
				continue;
			}
			const gap = [exact(metric.firstNs) - start, end - exact(metric.lastNs), exact(metric.maxGapNs)].reduce((a, b) =>
				a > b ? a : b,
			);
			if (gap > largest) largest = gap;
			if (gap > exact(maxGapNs) || end - exact(metric.lastNs) > exact(maxAgeNs)) {
				metric.status = 'unknown';
				metric.reason = 'gap-or-stale';
			}
		}
		const formalCovered = state.safetyOnly
			? null
			: start <= exact(state.formalWindow.startNs) &&
				end >= exact(state.formalWindow.endNs) &&
				exact(state.formalWindow.endNs) > exact(state.formalWindow.startNs);
		const complete =
			!cancelled &&
			(state.safetyOnly || formalCovered) &&
			end >= start &&
			state.errorCount === 0 &&
			requiredMetrics.every((k) => metrics[k].status === 'observed');
		const generatorProviders = providers.filter((provider) => provider.generatorProcess === true);
		const workerSamples = [];
		if (!state.safetyOnly)
			for (const row of state.samples) {
				if (
					!generatorProviders.some((provider) => provider.id === row.providerId) ||
					row.data.generatorProcess !== true ||
					row.data.interval?.clockDomain !== clockDomain
				)
					continue;
				const intervalStart = exact(row.data.interval.startNs),
					intervalEnd = exact(row.data.interval.endNs);
				const cpuPercent = row.data.metrics['node.cpuPercent'],
					loopP99Ms = row.data.metrics['node.loopP99Ms'];
				if (
					intervalEnd <= exact(state.formalWindow.startNs) ||
					intervalStart >= exact(state.formalWindow.endNs) ||
					intervalEnd <= intervalStart ||
					!Number.isFinite(cpuPercent) ||
					!Number.isFinite(loopP99Ms)
				)
					continue;
				workerSamples.push({
					workerId: row.providerId,
					monoNs: String(intervalEnd),
					startNs: String(intervalStart),
					endNs: String(intervalEnd),
					clockDomain,
					cpuPercent,
					loopP99Ms,
				});
			}
		let generator = null;
		if (!state.safetyOnly) {
			const ids = generatorProviders.map((provider) => provider.id),
				cellNs = BigInt(intervalMs) * 1000000n;
			generator = {
				known: false,
				workerSamples: [],
				rawWorkerIntervals: workerSamples,
				workerCoverage: {
					expectedWorkerIds: ids,
					expectedSamplesPerWorker: Number(
						(exact(state.formalWindow.endNs) - exact(state.formalWindow.startNs)) / cellNs,
					),
					pollingComplete: complete,
				},
				scope: 'one-explicit-physical-generator-process',
				clockDomain,
			};
			try {
				if (!complete || ids.length !== 1) throw Error('Generator observation incomplete');
				const envelope = generatorIntervalEnvelope({
					byWorker: new Map(ids.map((id) => [id, workerSamples.filter((row) => row.workerId === id)])),
					workerIds: ids,
					startNs: state.formalWindow.startNs,
					endNs: state.formalWindow.endNs,
					cellNs: String(cellNs),
					maxIntervalNs: maxGapNs,
				});
				generator.workerSamples = envelope.samples.map((row) => ({
					...row,
					monoNs: String((exact(row.startNs) + exact(row.endNs)) / 2n),
					clockDomain,
				}));
				generator.proof = envelope.proof;
				generator.known = true;
			} catch {
				generator.reason = 'actual-generator-interval-envelope-unavailable';
			}
		}
		return {
			generator,
			schema: state.safetyOnly ? 'benchmark.observation-safety.v1' : 'benchmark.observation.v1',
			safetyOnly: state.safetyOnly,
			stageId: state.stageId,
			clockDomain,
			window: {startNs: state.startNs, endNs: String(end)},
			formalWindow: state.formalWindow,
			samples: state.samples,
			errors: state.errors,
			errorCount: state.errorCount,
			bytes: state.bytes,
			metrics,
			coverage: {
				pollingComplete: complete,
				maxGapNs: String(largest),
				maxAllowedGapNs: String(maxGapNs),
				kind: 'discrete-polling-not-continuous-cpu',
				formalCovered,
			},
			complete,
			cancelled,
		};
	};
	const begin = async (plan, safetyOnly = false) => {
		if (state && !state.closed) throw Error('Observation stage already active');
		if (typeof plan?.stageId !== 'string' || !plan.stageId) throw Error('Stage identity required');
		if (!safetyOnly && exact(plan.formalEndNs) <= exact(plan.formalStartNs))
			throw Error('Positive formal window required');
		state = {
			safetyOnly,
			stageId: plan.stageId,
			startNs: String(exact(nowNs())),
			formalWindow: safetyOnly ? null : {startNs: plan.formalStartNs, endNs: plan.formalEndNs},
			samples: [],
			failedProviders: new Set(),
			lastPollNs: null,
			errors: [],
			errorCount: 0,
			bytes: 0,
			closed: false,
		};
		for (const provider of providers) {
			try {
				await provider.start?.();
			} catch {
				failure(provider.id, 'provider-start-failed');
				await onViolation({providerId: provider.id, reason: 'provider-start-failed'});
			}
		}
		await sample();
		timer = schedule(() => {
			sample().catch(() => {});
		}, intervalMs);
	};

	return {
		setViolationHandler(handler) {
			if (typeof handler !== 'function') throw Error('Violation handler required');
			onViolation = handler;
		},
		beginStage: (plan) => begin(plan),
		beginSafety: (plan = {stageId: 'initialization'}) => begin(plan, true),
		endSafety: () => {
			if (!state?.safetyOnly) throw Error('No safety-only window active');
			return finish({stageId: state.stageId}, false);
		},
		sample,
		endStage: (plan) => finish(plan, false),
		async cancel() {
			if (!state || state.closed) return null;
			return finish({stageId: state.stageId}, true);
		},
		close() {
			if (state && !state.closed) throw Error('Finish/cancel active stage first');
			return resourceLog.close();
		},
	};
}
