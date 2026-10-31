// SPDX-License-Identifier: AGPL-3.0-or-later

import {createHash} from 'node:crypto';

/** 用真实连续区间构造保守包络；时长、工作者和网格均显式指定。 */
export function generatorIntervalEnvelope({
	byWorker,
	workerIds,
	startNs,
	endNs,
	cellNs,
	maxIntervalNs,
	maxCells = 100000,
} = {}) {
	const exact = (value) => {
		if (typeof value !== 'bigint' && (typeof value !== 'string' || !/^\d+$/.test(value)))
			throw Error('Exact nonnegative decimal nanoseconds required');
		const result = BigInt(value);
		if (result < 0n) throw Error('Negative timestamp');
		return result;
	};
	const start = exact(startNs),
		end = exact(endNs),
		cell = exact(cellNs),
		maximum = exact(maxIntervalNs);
	if (
		!(byWorker instanceof Map) ||
		!Array.isArray(workerIds) ||
		!workerIds.length ||
		workerIds.some((id) => typeof id !== 'string' || !id) ||
		new Set(workerIds).size !== workerIds.length ||
		end <= start ||
		cell <= 0n ||
		maximum <= 0n ||
		(end - start) % cell !== 0n ||
		!Number.isSafeInteger(maxCells) ||
		maxCells < 1 ||
		maxCells > 100000 ||
		((end - start) / cell) * BigInt(workerIds.length) > BigInt(maxCells)
	)
		throw Error('Bounded interval configuration required');
	const samples = [],
		proofs = [];
	for (const workerId of workerIds) {
		const all = byWorker.get(workerId);
		if (!Array.isArray(all) || all.length > 100000) throw Error('Bounded actual CPU intervals missing');
		const rows = all.filter((row) => exact(row.endNs) > start && exact(row.startNs) < end);
		if (!rows.length) throw Error('Actual worker intervals missing');
		let cursor = start,
			previousEnd = null,
			largest = 0n;
		for (const row of rows) {
			const lower = exact(row.startNs),
				upper = exact(row.endNs),
				duration = upper - lower;
			if (
				duration <= 0n ||
				duration > maximum ||
				(previousEnd === null ? lower > start : lower !== previousEnd) ||
				upper <= cursor ||
				!Number.isFinite(row.cpuPercent) ||
				row.cpuPercent < 0 ||
				!Number.isFinite(row.loopP99Ms) ||
				row.loopP99Ms < 0
			)
				throw Error('CPU interval gap, overlap, order or metric invalid');
			previousEnd = upper;
			cursor = upper < end ? upper : end;
			if (duration > largest) largest = duration;
		}
		if (cursor !== end) throw Error('Actual intervals do not cover the complete window');
		let index = 0;
		for (let lower = start; lower < end; lower += cell) {
			const upper = lower + cell;
			while (exact(rows[index].endNs) <= lower) index++;
			let covered = lower,
				cpuPercent = 0,
				loopP99Ms = 0;
			const sourceIntervals = [];
			for (let scan = index; scan < rows.length && exact(rows[scan].startNs) < upper; scan++) {
				const row = rows[scan],
					rowUpper = exact(row.endNs);
				if (exact(row.startNs) > covered) throw Error('Unobserved diagnostic cell');
				covered = rowUpper < upper ? rowUpper : upper;
				cpuPercent = Math.max(cpuPercent, row.cpuPercent);
				loopP99Ms = Math.max(loopP99Ms, row.loopP99Ms);
				sourceIntervals.push(scan);
			}
			if (covered !== upper || !sourceIntervals.length) throw Error('Unobserved diagnostic cell');
			samples.push({
				workerId,
				startNs: String(lower),
				endNs: String(upper),
				cpuPercent,
				loopP99Ms,
				derivedConservativeEnvelope: true,
				sourceIntervals,
			});
		}
		proofs.push({
			workerId,
			coveredStartNs: String(start),
			coveredEndNs: String(end),
			observedIntervalCount: rows.length,
			maxActualIntervalNs: String(largest),
			sourceRowsSha256: createHash('sha256')
				.update(JSON.stringify(rows, (_, value) => (typeof value === 'bigint' ? String(value) : value)))
				.digest('hex'),
		});
	}
	return {
		samples,
		proof: {
			method: 'actual-contiguous-CPU-intervals; conservative-max-envelope',
			derivedCellsAreNotIndependentRawSamples: true,
			missingRawIntervalsInvented: false,
			workerProofs: proofs,
		},
	};
}
