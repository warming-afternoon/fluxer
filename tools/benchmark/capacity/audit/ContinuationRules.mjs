// SPDX-License-Identifier: AGPL-3.0-or-later
// Source-derived R22 continuation rules; pure, explicit configurable policy.
const RULES_VERSION = 'continuation.portable.v1';
const EPSILON = 1e-9;

function finite(value) {
	return typeof value === 'number' && Number.isFinite(value);
}

function median(values) {
	const sorted = [...values].sort((a, b) => a - b);
	if (sorted.length === 0) return null;
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function linearSlope(points) {
	if (points.length < 2) return null;
	const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
	const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
	let numerator = 0;
	let denominator = 0;
	for (const point of points) {
		numerator += (point.x - meanX) * (point.y - meanY);
		denominator += (point.x - meanX) ** 2;
	}
	return denominator > 0 ? numerator / denominator : null;
}

function theilSen(points) {
	const slopes = [];
	for (let left = 0; left < points.length; left += 1) {
		for (let right = left + 1; right < points.length; right += 1) {
			const elapsed = points[right].x - points[left].x;
			if (elapsed > 0) slopes.push((points[right].y - points[left].y) / elapsed);
		}
	}
	return median(slopes);
}

function nearestPoint(points, targetMonoMs, maxDistanceMs) {
	let best = null;
	for (const point of points) {
		const distance = Math.abs(point.monoMs - targetMonoMs);
		if (distance <= maxDistanceMs && (!best || distance < best.distance)) best = {point, distance};
	}
	return best?.point ?? null;
}

function histogramShape(histogram) {
	if (!Array.isArray(histogram) || histogram.length === 0) return null;
	const bins = histogram.map((bin) => ({upperBoundMs: bin.upperBoundMs, count: bin.count}));
	if (bins.some((bin) => !finite(bin.upperBoundMs) || !Number.isInteger(bin.count) || bin.count < 0)) return null;
	if (bins.some((bin, index) => index > 0 && bin.upperBoundMs <= bins[index - 1].upperBoundMs)) return null;
	return bins;
}

function mergeHistograms(histograms) {
	if (histograms.length === 0) return null;
	const normalized = histograms.map(histogramShape);
	if (normalized.some((histogram) => !histogram)) return null;
	const countsByBound = new Map();
	for (const histogram of normalized) {
		for (const bin of histogram)
			countsByBound.set(bin.upperBoundMs, (countsByBound.get(bin.upperBoundMs) ?? 0) + bin.count);
	}
	return [...countsByBound]
		.sort(([left], [right]) => left - right)
		.map(([upperBoundMs, count]) => ({upperBoundMs, count}));
}

function histogramQuantile(histogram, quantile) {
	const normalized = histogramShape(histogram);
	if (!normalized) return null;
	const total = normalized.reduce((sum, bin) => sum + bin.count, 0);
	if (total <= 0) return null;
	const rank = Math.max(1, Math.ceil(total * quantile));
	let cumulative = 0;
	for (const bin of normalized) {
		cumulative += bin.count;
		if (cumulative >= rank) return bin.upperBoundMs;
	}
	return normalized.at(-1).upperBoundMs;
}

function allPassed(gates) {
	const entries = Object.entries(gates ?? {});
	if (entries.length === 0) return {known: false, passed: false, gates: []};
	const details = entries.map(([name, gate]) => ({
		name,
		status: Array.isArray(gate?.refs) && gate.refs.length > 0 ? (gate?.status ?? 'unknown') : 'unknown',
		passed: gate?.status === 'pass' && Array.isArray(gate?.refs) && gate.refs.length > 0,
		refs: Array.isArray(gate?.refs) ? [...gate.refs] : [],
	}));
	return {
		known: details.every((gate) => gate.status === 'pass' || gate.status === 'fail'),
		passed: details.every((gate) => gate.passed),
		gates: details,
	};
}

function makeRollingWindows(points, boundary, targetFanoutRatePerSecond, maxEndpointDistanceMs, policy) {
	const windows = [];
	for (
		let endOffsetSeconds = policy.rollingWindowSeconds;
		endOffsetSeconds <= policy.formalWindowSeconds;
		endOffsetSeconds += policy.rollingStepSeconds
	) {
		const startOffsetSeconds = endOffsetSeconds - policy.rollingWindowSeconds;
		const start = nearestPoint(points, boundary.startMonoMs + startOffsetSeconds * 1000, maxEndpointDistanceMs);
		const end = nearestPoint(points, boundary.startMonoMs + endOffsetSeconds * 1000, maxEndpointDistanceMs);
		if (!start || !end || end.monoMs <= start.monoMs) {
			windows.push({
				startOffsetSeconds,
				endOffsetSeconds,
				observed: false,
				reachesTarget99: null,
				submittedRatio: null,
				successfulRatio: null,
				uniqueWsRatio: null,
			});
			continue;
		}
		const elapsedSeconds = (end.monoMs - start.monoMs) / 1000;
		const expected = targetFanoutRatePerSecond * elapsedSeconds;
		const ratios = {
			submittedRatio: (end.submittedExpected - start.submittedExpected) / expected,
			successfulRatio: (end.successfulExpected - start.successfulExpected) / expected,
			uniqueWsRatio: (end.uniqueWs - start.uniqueWs) / expected,
		};
		const observed = Object.values(ratios).every(finite) && Object.values(ratios).every((value) => value >= -EPSILON);
		windows.push({
			startOffsetSeconds,
			endOffsetSeconds,
			observed,
			...ratios,
			reachesTarget99:
				observed && ratios.submittedRatio >= policy.minSupplyRatio && ratios.successfulRatio >= policy.minSupplyRatio,
			uniqueWsReachesTarget99: observed && ratios.uniqueWsRatio >= policy.rollingReceiveRatio,
		});
	}
	const expectedWindows =
		Math.floor((policy.formalWindowSeconds - policy.rollingWindowSeconds) / policy.rollingStepSeconds) + 1;
	const observed = windows.filter((window) => window.observed);
	const submittedAndSuccessPass =
		windows.length === expectedWindows &&
		observed.length === expectedWindows &&
		observed.filter((window) => window.reachesTarget99).length / expectedWindows >= policy.minPassingWindowFraction;
	const receivePass =
		windows.length === expectedWindows &&
		observed.length === expectedWindows &&
		observed.filter((window) => window.uniqueWsReachesTarget99).length / expectedWindows >=
			policy.minPassingWindowFraction;
	const supplyShortfall = windows.some((window) => window.observed && !window.reachesTarget99);
	const receiveShortfall = windows.some((window) => window.observed && !window.uniqueWsReachesTarget99);
	let maxSupplyShortfallSpanSeconds = 0;
	let maxReceiveShortfallSpanSeconds = 0;
	const span = (isBelow) => {
		let maximum = 0;
		let runStart = null;
		let lastOffset = null;
		for (const window of windows) {
			if (window.observed && isBelow(window)) {
				if (runStart === null) runStart = window.endOffsetSeconds;
				lastOffset = window.endOffsetSeconds;
			} else if (runStart !== null) {
				maximum = Math.max(maximum, lastOffset - runStart);
				runStart = null;
				lastOffset = null;
			}
		}
		if (runStart !== null) maximum = Math.max(maximum, lastOffset - runStart);
		return maximum;
	};
	maxSupplyShortfallSpanSeconds = span((window) => !window.reachesTarget99);
	maxReceiveShortfallSpanSeconds = span((window) => !window.uniqueWsReachesTarget99);
	return {
		windows,
		coverage: {
			observedWindows: observed.length,
			totalWindows: windows.length,
			passingSupplyWindows: observed.filter((window) => window.reachesTarget99).length,
			passingReceiveWindows: observed.filter((window) => window.uniqueWsReachesTarget99).length,
		},
		supplyPass: submittedAndSuccessPass && maxSupplyShortfallSpanSeconds < policy.maxShortfallSeconds,
		receiveCoveragePass: receivePass && maxReceiveShortfallSpanSeconds < policy.maxShortfallSeconds,
		maxSupplyShortfallSpanSeconds,
		maxReceiveShortfallSpanSeconds,
		supplyShortfallObserved: supplyShortfall,
		receiveShortfallObserved: receiveShortfall,
	};
}

function backlogAssessment(points, startMonoMs, endMonoMs, targetFanoutRatePerSecond, policy) {
	const samples = points.filter((point) => point.monoMs >= startMonoMs && point.monoMs <= endMonoMs);
	if (samples.length < 2)
		return {known: false, persistent: false, fullWindowSlopePerSecond: null, qualifyingWindows: []};
	const watermarkPoints = samples.map((point) => ({
		x: point.monoMs / 1000,
		y: point.submittedExpected - point.uniqueWs,
	}));
	const fullWindowSlopePerSecond = linearSlope(watermarkPoints);
	const qualifyingWindows = [];
	let observedWindowCount = 0;
	for (const start of samples) {
		const end = nearestPoint(points, start.monoMs + policy.backlogWindowSeconds * 1000, policy.endpointToleranceMs);
		if (!end || end.monoMs > endMonoMs || end.monoMs - start.monoMs < policy.backlogWindowSeconds * 1000) continue;
		const segment = points.filter((point) => point.monoMs >= start.monoMs && point.monoMs <= end.monoMs);
		if (segment.length < 2 || segment[0].monoMs !== start.monoMs || segment.at(-1).monoMs !== end.monoMs) continue;
		observedWindowCount += 1;
		const startWatermark = start.submittedExpected - start.uniqueWs;
		const endWatermark = end.submittedExpected - end.uniqueWs;
		const slope = linearSlope(
			segment.map((point) => ({x: point.monoMs / 1000, y: point.submittedExpected - point.uniqueWs})),
		);
		const ageRising = segment.every(
			(point, index) =>
				index === 0 ||
				(finite(point.pendingAgeMs) &&
					finite(segment[index - 1].pendingAgeMs) &&
					point.pendingAgeMs > segment[index - 1].pendingAgeMs),
		);
		const ageAtLeastOneSecond = finite(end.pendingAgeMs) && end.pendingAgeMs >= policy.maxPendingAgeMs;
		const increase = endWatermark - startWatermark;
		const qualifies =
			finite(slope) &&
			slope > targetFanoutRatePerSecond * policy.maxBacklogSlopeRatio &&
			increase > targetFanoutRatePerSecond * policy.maxBacklogIncreaseSeconds &&
			ageRising &&
			ageAtLeastOneSecond;
		qualifyingWindows.push({
			startMonoMs: start.monoMs,
			endMonoMs: end.monoMs,
			slopePerSecond: slope,
			watermarkIncrease: increase,
			startPendingAgeMs: start.pendingAgeMs,
			endPendingAgeMs: end.pendingAgeMs,
			ageRising,
			qualifies,
		});
	}
	return {
		known:
			finite(fullWindowSlopePerSecond) &&
			observedWindowCount > 0 &&
			samples.every((point) => finite(point.pendingAgeMs)),
		persistent: qualifyingWindows.some((window) => window.qualifies),
		fullWindowSlopePerSecond,
		observed120SecondWindows: observedWindowCount,
		firstWatermark: watermarkPoints[0].y,
		lastWatermark: watermarkPoints.at(-1).y,
		maxWatermark: Math.max(...watermarkPoints.map((point) => point.y)),
		qualifyingWindows,
	};
}

function latencyAssessment(windows, policy, histogramKey = 'uniqueWsHistogram') {
	const ordered = [...(windows ?? [])].sort((a, b) => a.startMonoMs - b.startMonoMs);
	if (
		ordered.length !== policy.latencyWindowCount ||
		ordered.some(
			(window, index) =>
				!finite(window.startMonoMs) ||
				!finite(window.endMonoMs) ||
				Math.abs(window.endMonoMs - window.startMonoMs - policy.latencyWindowSeconds * 1000) > 0.001 ||
				(index > 0 && window.startMonoMs !== ordered[index - 1].endMonoMs),
		)
	) {
		return {
			known: false,
			reason: 'complete contiguous configured latency histograms required',
			sustainedGrowth: null,
			first120P95Ms: null,
			last120P95Ms: null,
			theilSenSlopeMsPerSecond: null,
		};
	}
	const perWindow = ordered.map((window) => histogramQuantile(window[histogramKey], 0.95));
	if (perWindow.some((value) => value === null))
		return {
			known: false,
			reason: `missing or invalid ${histogramKey}`,
			sustainedGrowth: null,
			first120P95Ms: null,
			last120P95Ms: null,
			theilSenSlopeMsPerSecond: null,
		};
	const firstMerged = mergeHistograms(
		ordered.slice(0, policy.latencyComparisonWindows).map((window) => window[histogramKey]),
	);
	const lastMerged = mergeHistograms(
		ordered.slice(-policy.latencyComparisonWindows).map((window) => window[histogramKey]),
	);
	if (!firstMerged || !lastMerged)
		return {
			known: false,
			reason: 'histogram bucket layout differs',
			sustainedGrowth: null,
			first120P95Ms: null,
			last120P95Ms: null,
			theilSenSlopeMsPerSecond: null,
		};
	const first120P95Ms = histogramQuantile(firstMerged, 0.95);
	const last120P95Ms = histogramQuantile(lastMerged, 0.95);
	const theilSenSlopeMsPerSecond = theilSen(
		ordered.map((window, index) => ({x: (window.endMonoMs - ordered[0].startMonoMs) / 1000, y: perWindow[index]})),
	);
	const sustainedGrowth =
		last120P95Ms > first120P95Ms * policy.maxLatencyGrowthRatio &&
		last120P95Ms > first120P95Ms + policy.maxLatencyGrowthMs &&
		theilSenSlopeMsPerSecond > policy.latencySlopeMsPerSecond &&
		perWindow
			.slice(-policy.latencyTailWindowCount)
			.every((value, index, tail) => index === 0 || value >= tail[index - 1] - policy.latencyTailJitterMs) &&
		perWindow.at(-1) > perWindow.at(-policy.latencyTailWindowCount);
	const threeConsecutiveAbove1000Ms = perWindow.some(
		(_value, index) =>
			index >= policy.scheduledLagConsecutiveWindows - 1 &&
			perWindow
				.slice(index - policy.scheduledLagConsecutiveWindows + 1, index + 1)
				.every((item) => item > policy.scheduledLagMaxMs),
	);
	return {
		known: true,
		sustainedGrowth,
		first120P95Ms,
		last120P95Ms,
		perWindowP95Ms: perWindow,
		theilSenSlopeMsPerSecond,
		first120WindowP95MeanMs:
			perWindow.slice(0, policy.latencyComparisonWindows).reduce((a, b) => a + b, 0) / policy.latencyComparisonWindows,
		last120WindowP95MeanMs:
			perWindow.slice(-policy.latencyComparisonWindows).reduce((a, b) => a + b, 0) / policy.latencyComparisonWindows,
		threeConsecutiveAbove1000Ms,
	};
}

function generatorAssessment(workerSamples, coverage, policy) {
	if (
		!Array.isArray(workerSamples) ||
		workerSamples.length === 0 ||
		!Array.isArray(coverage?.expectedWorkerIds) ||
		coverage.expectedWorkerIds.length === 0 ||
		!Number.isInteger(coverage.expectedSamplesPerWorker) ||
		coverage.expectedSamplesPerWorker < 1
	) {
		return {
			known: false,
			pressure: null,
			classification: 'unknown',
			cpuUnit: 'single-core-percent-per-worker',
			coverage: null,
			workers: [],
		};
	}
	const grouped = new Map();
	for (const sample of workerSamples) {
		if (typeof sample.workerId !== 'string' || !finite(sample.cpuPercent) || !finite(sample.loopP99Ms)) continue;
		const rows = grouped.get(sample.workerId) ?? [];
		rows.push(sample);
		grouped.set(sample.workerId, rows);
	}
	if (grouped.size === 0)
		return {
			known: false,
			pressure: null,
			classification: 'unknown',
			cpuUnit: 'single-core-percent-per-worker',
			coverage: null,
			workers: [],
		};
	const workers = [...grouped].map(([workerId, rows]) => {
		const averageCpuPercent = rows.reduce((sum, row) => sum + row.cpuPercent, 0) / rows.length;
		return {
			workerId,
			samples: rows.length,
			averageCpuPercent,
			loopP99Over100MsSamples: rows.filter((row) => row.loopP99Ms > policy.generatorLoopP99MaxMs).length,
		};
	});
	const totalLoopSamples = [...grouped.values()].reduce((sum, rows) => sum + rows.length, 0);
	const loopOverSamples = [...grouped.values()].reduce(
		(sum, rows) => sum + rows.filter((row) => row.loopP99Ms > policy.generatorLoopP99MaxMs).length,
		0,
	);
	const pressure =
		workers.some((worker) => worker.averageCpuPercent >= policy.generatorCpuMaxPercent) ||
		loopOverSamples / totalLoopSamples >= policy.generatorLoopFraction;
	const coverageByWorker = coverage.expectedWorkerIds.map((workerId) => ({
		workerId,
		expectedSamples: coverage.expectedSamplesPerWorker,
		actualSamples: grouped.get(workerId)?.length ?? 0,
		complete: grouped.get(workerId)?.length === coverage.expectedSamplesPerWorker,
	}));
	const sampleDataValid = workerSamples.every(
		(sample) =>
			typeof sample.workerId === 'string' &&
			finite(sample.monoMs) &&
			finite(sample.cpuPercent) &&
			sample.cpuPercent >= 0 &&
			finite(sample.loopP99Ms) &&
			sample.loopP99Ms >= 0,
	);
	const expectedWorkersUnique = new Set(coverage.expectedWorkerIds).size === coverage.expectedWorkerIds.length;
	const known =
		sampleDataValid &&
		expectedWorkersUnique &&
		coverageByWorker.every((row) => row.complete) &&
		grouped.size === coverage.expectedWorkerIds.length;
	return {
		known,
		pressure,
		classification: pressure ? 'generator-pressure' : 'no-generator-pressure-detected',
		cpuUnit: 'single-core-percent-per-worker; worker CPU is not summed',
		coverage: {
			expectedWorkers: coverage.expectedWorkerIds.length,
			coveredWorkers: coverageByWorker.filter((row) => row.complete).length,
			expectedSamplesPerWorker: coverage.expectedSamplesPerWorker,
			byWorker: coverageByWorker,
		},
		loopP99Over100MsSamples: loopOverSamples,
		loopSamples: totalLoopSamples,
		workers,
	};
}

/** Pure continuation.v1 assessment. All timestamps/counts/histograms are caller-supplied evidence. */
export function assessMixedCapacityTrend(input) {
	if (!input || input.rulesVersion !== RULES_VERSION) throw new TypeError(`rulesVersion must be ${RULES_VERSION}`);
	const boundary = input.formalWindow;
	const targetFanoutRatePerSecond = input.targetFanoutRatePerSecond;
	if (
		!boundary ||
		!finite(boundary.startMonoMs) ||
		!finite(boundary.endMonoMs) ||
		boundary.endMonoMs <= boundary.startMonoMs
	)
		throw new TypeError('formalWindow must provide actual positive monotonic boundary');
	if (!finite(targetFanoutRatePerSecond) || targetFanoutRatePerSecond <= 0)
		throw new TypeError('targetFanoutRatePerSecond must be positive');
	const points = Array.isArray(input.timingPoints) ? [...input.timingPoints] : [];
	const timingValidationErrors = [];
	if (points.length < 2) timingValidationErrors.push('at least two timing points are required');
	for (let index = 0; index < points.length; index += 1) {
		const point = points[index];
		if (
			!finite(point.monoMs) ||
			!['submittedExpected', 'successfulExpected', 'uniqueWs'].every(
				(key) => Number.isSafeInteger(point[key]) && point[key] >= 0,
			) ||
			(point.pendingAgeMs !== null &&
				point.pendingAgeMs !== undefined &&
				(!finite(point.pendingAgeMs) || point.pendingAgeMs < 0))
		) {
			timingValidationErrors.push(`timing point ${index} has invalid timestamp, count, or pending age`);
			continue;
		}
		if (index > 0) {
			const previous = points[index - 1];
			if (!finite(previous.monoMs) || point.monoMs <= previous.monoMs)
				timingValidationErrors.push(`timing point ${index} timestamp is not strictly increasing`);
			for (const key of ['submittedExpected', 'successfulExpected', 'uniqueWs']) {
				if (Number.isSafeInteger(previous[key]) && point[key] < previous[key])
					timingValidationErrors.push(`timing point ${index} ${key} counter decreased`);
			}
		}
	}
	const pointShapeValid = timingValidationErrors.length === 0;
	const thresholds = input.policy;
	validateContinuationPolicy(thresholds);
	if (Math.abs((boundary.endMonoMs - boundary.startMonoMs) / 1000 - thresholds.formalWindowSeconds) > 0.000001)
		throw Error('Policy/formal window differs');
	const endpointStart = pointShapeValid
		? nearestPoint(points, boundary.startMonoMs, thresholds.endpointToleranceMs)
		: null;
	const endpointEnd = pointShapeValid ? nearestPoint(points, boundary.endMonoMs, thresholds.endpointToleranceMs) : null;
	const fullWindowKnown = Boolean(endpointStart && endpointEnd && endpointEnd.monoMs > endpointStart.monoMs);
	const fullElapsedSeconds = fullWindowKnown ? (endpointEnd.monoMs - endpointStart.monoMs) / 1000 : null;
	const fullExpected = fullWindowKnown ? targetFanoutRatePerSecond * fullElapsedSeconds : null;
	const fullWindow = fullWindowKnown
		? {
				startMonoMs: endpointStart.monoMs,
				endMonoMs: endpointEnd.monoMs,
				elapsedSeconds: fullElapsedSeconds,
				startCounters: {
					submittedExpected: endpointStart.submittedExpected,
					successfulExpected: endpointStart.successfulExpected,
					uniqueWs: endpointStart.uniqueWs,
				},
				endCounters: {
					submittedExpected: endpointEnd.submittedExpected,
					successfulExpected: endpointEnd.successfulExpected,
					uniqueWs: endpointEnd.uniqueWs,
				},
				submittedRatio: (endpointEnd.submittedExpected - endpointStart.submittedExpected) / fullExpected,
				successfulRatio: (endpointEnd.successfulExpected - endpointStart.successfulExpected) / fullExpected,
				uniqueWsRatio: (endpointEnd.uniqueWs - endpointStart.uniqueWs) / fullExpected,
				pendingFanoutStart: endpointStart.submittedExpected - endpointStart.uniqueWs,
				pendingFanoutEnd: endpointEnd.submittedExpected - endpointEnd.uniqueWs,
				successfulHttpMinusUniqueWsEnd: endpointEnd.successfulExpected - endpointEnd.uniqueWs,
				pendingAgeStartMs: endpointStart.pendingAgeMs ?? null,
				pendingAgeEndMs: endpointEnd.pendingAgeMs ?? null,
			}
		: null;
	const rolling = pointShapeValid
		? makeRollingWindows(points, boundary, targetFanoutRatePerSecond, thresholds.endpointToleranceMs, thresholds)
		: {
				windows: [],
				coverage: {observedWindows: 0, totalWindows: null, passingSupplyWindows: 0, passingReceiveWindows: 0},
				supplyPass: false,
				receiveCoveragePass: false,
				maxShortfallSpanSeconds: null,
				shortfallObserved: false,
			};
	const backlog = pointShapeValid
		? backlogAssessment(points, boundary.startMonoMs, boundary.endMonoMs, targetFanoutRatePerSecond, thresholds)
		: {known: false, persistent: false, fullWindowSlopePerSecond: null, qualifyingWindows: []};
	const latency = latencyAssessment(input.latencyWindows, thresholds);
	const scheduledLatency = latencyAssessment(input.latencyWindows, thresholds, 'scheduledLagHistogram');
	const httpLatency = latencyAssessment(input.latencyWindows, thresholds, 'httpLatencyHistogram');
	const scheduledLagPass =
		scheduledLatency.known &&
		!scheduledLatency.threeConsecutiveAbove1000Ms &&
		scheduledLatency.last120P95Ms - scheduledLatency.first120P95Ms <= thresholds.scheduledLagMaxMs;
	const generator = generatorAssessment(input.workerSamples, input.workerCoverage, thresholds);
	const gates = allPassed(input.gates);
	const endpointSupplyPass =
		fullWindowKnown &&
		fullWindow.submittedRatio >= thresholds.endpointSupplyRatio &&
		fullWindow.successfulRatio >= thresholds.endpointSupplyRatio;
	const endpointReceivePass = fullWindowKnown && fullWindow.uniqueWsRatio >= thresholds.minReceiveRatio;
	const sendSupplyPass = endpointSupplyPass && rolling.supplyPass && scheduledLagPass;
	const receiveCoveragePass = endpointReceivePass;
	const tail = input.tail ?? {};
	const tailKnown = finite(tail.wsTailMs) && finite(tail.endWatermarkFanout);
	const tailPass =
		tailKnown &&
		tail.wsTailMs >= 0 &&
		tail.endWatermarkFanout >= 0 &&
		tail.wsTailMs <= thresholds.maxTailMs &&
		tail.endWatermarkFanout <= targetFanoutRatePerSecond * thresholds.maxEndBacklogSeconds;
	const supplyEvidenceKnown =
		fullWindowKnown &&
		rolling.coverage.observedWindows ===
			Math.floor((thresholds.formalWindowSeconds - thresholds.rollingWindowSeconds) / thresholds.rollingStepSeconds) +
				1 &&
		scheduledLatency.known;
	const classification = !gates.passed
		? gates.known
			? {outcome: '原质量/资源/时钟/ACK/正确性/冻结/cleanup门失败', mayContinue: false, stopAxis: true}
			: {outcome: '证据不足，继续资格未知', mayContinue: false, stopAxis: true}
		: !supplyEvidenceKnown
			? {outcome: '正式窗或滚动供给采样缺失，结果未知，不能升级', mayContinue: false, stopAxis: true}
			: !sendSupplyPass
				? {
						outcome: generator.pressure
							? '发生器/发送链欠供给，发生器有压力，服务器上限未判'
							: '发生器/发送链欠供给，服务器上限未判',
						mayContinue: false,
						stopAxis: false,
					}
				: backlog.persistent
					? {
							outcome: receiveCoveragePass ? '持续接收积压，停止该轴' : 'WS覆盖不足并出现持续接收积压，停止该轴',
							mayContinue: false,
							stopAxis: true,
						}
					: latency.known && latency.sustainedGrowth
						? {
								outcome: receiveCoveragePass ? '持续延迟增长，停止该轴' : 'WS覆盖不足并出现持续延迟增长，停止该轴',
								mayContinue: false,
								stopAxis: true,
							}
						: !tailPass
							? {
									outcome: receiveCoveragePass
										? '尾部/测量不足，未证明稳定容量'
										: 'WS覆盖不足且尾部约束未通过，未证明稳定容量',
									mayContinue: false,
									stopAxis: true,
								}
							: !receiveCoveragePass
								? {
										outcome: '正式窗WS接收覆盖不足，缺乏持续趋势证据，未证明稳定容量',
										mayContinue: false,
										stopAxis: true,
									}
								: !backlog.known || !latency.known || !generator.known
									? {outcome: '趋势或发生器证据未知，不能升级', mayContinue: false, stopAxis: true}
									: {outcome: '通过当前档，可按授权顺序继续', mayContinue: true, stopAxis: false};
	return {
		rulesVersion: RULES_VERSION,
		thresholds,
		formalWindow: {...boundary, known: fullWindowKnown, elapsedSeconds: fullElapsedSeconds},
		timingValidation: {known: pointShapeValid, errors: timingValidationErrors},
		fullWindow,
		rollingSupply: {...rolling, targetFanoutRatePerSecond},
		sendSupplyAssessment: {
			endpointPass: endpointSupplyPass,
			rollingPass: rolling.supplyPass,
			scheduledLagPass,
			pass: sendSupplyPass,
		},
		backlog,
		latency,
		scheduledLatency: {...scheduledLatency, pass: scheduledLagPass},
		httpLatency,
		generator,
		qualityResourceAckGates: gates,
		tail: {...tail, known: tailKnown, pass: tailPass},
		supplyClassification: sendSupplyPass
			? generator.pressure
				? 'pressure-risk-without-shortfall'
				: 'adequate'
			: generator.pressure
				? 'generator-pressure-with-shortfall'
				: 'generator-or-send-chain-shortfall',
		decision: classification,
	};
}

export {RULES_VERSION};

/** Preserve R22 strict defaults for algorithm constants; caller supplies environment/rate and primary policy. */
export function createContinuationPolicy(input, formalWindowSeconds, latencyWindowSeconds) {
	const result = {
		endpointSupplyRatio: 0.995,
		rollingReceiveRatio: 0.99,
		latencySlopeMsPerSecond: 1,
		latencyTailJitterMs: 25,
		scheduledLagMaxMs: 1000,
		generatorCpuMaxPercent: 90,
		generatorLoopP99MaxMs: 100,
		generatorLoopFraction: 0.25,
		...input,
		formalWindowSeconds,
		latencyWindowSeconds,
	};
	result.latencyWindowCount = formalWindowSeconds / latencyWindowSeconds;
	result.latencyComparisonWindows ??= Math.min(2, Math.floor(result.latencyWindowCount / 2));
	result.latencyTailWindowCount ??= Math.min(3, result.latencyWindowCount);
	result.scheduledLagConsecutiveWindows ??= Math.min(3, result.latencyWindowCount);
	validateContinuationPolicy(result);
	return Object.freeze(result);
}
export function validateContinuationPolicy(p) {
	const fields = [
		'formalWindowSeconds',
		'rollingWindowSeconds',
		'rollingStepSeconds',
		'endpointToleranceMs',
		'minSupplyRatio',
		'minReceiveRatio',
		'minPassingWindowFraction',
		'maxShortfallSeconds',
		'backlogWindowSeconds',
		'maxBacklogSlopeRatio',
		'maxBacklogIncreaseSeconds',
		'maxPendingAgeMs',
		'maxTailMs',
		'maxEndBacklogSeconds',
		'maxLatencyGrowthRatio',
		'maxLatencyGrowthMs',
		'endpointSupplyRatio',
		'rollingReceiveRatio',
		'latencyWindowSeconds',
		'latencyWindowCount',
		'latencyComparisonWindows',
		'latencyTailWindowCount',
		'latencySlopeMsPerSecond',
		'latencyTailJitterMs',
		'scheduledLagMaxMs',
		'scheduledLagConsecutiveWindows',
		'generatorCpuMaxPercent',
		'generatorLoopP99MaxMs',
		'generatorLoopFraction',
	];
	if (!p || fields.some((k) => !finite(p[k]) || p[k] < 0)) throw Error('Complete finite continuation policy required');
	if (
		[
			'formalWindowSeconds',
			'rollingWindowSeconds',
			'rollingStepSeconds',
			'backlogWindowSeconds',
			'latencyWindowSeconds',
			'maxShortfallSeconds',
		].some((k) => p[k] <= 0) ||
		p.formalWindowSeconds / p.rollingStepSeconds > 100000
	)
		throw Error('Invalid or unbounded continuation windows');
	if (
		!Number.isInteger(p.latencyWindowCount) ||
		p.latencyWindowCount < 2 ||
		p.latencyWindowCount > 1000 ||
		['latencyComparisonWindows', 'latencyTailWindowCount', 'scheduledLagConsecutiveWindows'].some(
			(k) => !Number.isInteger(p[k]) || p[k] < 1 || p[k] > p.latencyWindowCount,
		)
	)
		throw Error('Invalid latency window coverage');
	if (
		[
			'minSupplyRatio',
			'minReceiveRatio',
			'minPassingWindowFraction',
			'endpointSupplyRatio',
			'rollingReceiveRatio',
			'generatorLoopFraction',
		].some((k) => p[k] > 1) ||
		p.endpointToleranceMs >= p.rollingWindowSeconds * 1000
	)
		throw Error('Invalid ratio or endpoint tolerance');
}
