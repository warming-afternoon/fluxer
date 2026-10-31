// SPDX-License-Identifier: AGPL-3.0-or-later

const SHA256 = /^[a-f0-9]{64}$/;
const DECIMAL_NS = /^\d+$/;

/** 校验同一边界合同，可供seal和离线summary重放共同调用。 */
export function validatePhaseBoundaryEvidence(evidence, expected = {}) {
	for (const value of [
		evidence?.startMonoNs,
		evidence?.endMonoNs,
		expected.nowMonoNs,
		...(evidence?.marks ?? []).map((mark) => mark.monoNs),
	]) {
		if (typeof value === 'number' && !Number.isSafeInteger(value))
			throw new Error('unsafe numeric monotonic clock; use decimal strings');
	}
	if (evidence?.schema !== 'benchmark.phase-boundary-evidence.v1' || evidence.observed !== true)
		throw new Error('observed phase-boundary evidence schema required');
	for (const key of ['scenarioId', 'runId', 'stageId', 'phaseId', 'clockSegmentId']) {
		if (typeof evidence[key] !== 'string' || evidence[key].length === 0 || evidence[key].length > 256) {
			throw new Error('complete phase identity required: ' + key);
		}
	}
	if (!Number.isSafeInteger(evidence.attemptNo) || evidence.attemptNo < 1) {
		throw new Error('positive exact attemptNo required');
	}

	for (const key of ['manifestSha256', 'recordSha256'])
		if (!SHA256.test(evidence[key] ?? '') || (expected[key] != null && evidence[key] !== expected[key]))
			throw new Error(`phase-boundary ${key} mismatch`);
	for (const key of ['scenarioId', 'runId', 'attemptNo', 'stageId', 'phaseId', 'clockSegmentId'])
		if (expected[key] != null && evidence[key] !== expected[key]) throw new Error(`phase-boundary ${key} mismatch`);
	if (
		!DECIMAL_NS.test(String(evidence.startMonoNs)) ||
		!DECIMAL_NS.test(String(evidence.endMonoNs)) ||
		BigInt(evidence.endMonoNs) <= BigInt(evidence.startMonoNs)
	)
		throw new Error('observed monotonic boundary order is invalid');
	if (
		(expected.startMonoNs != null && String(evidence.startMonoNs) !== String(expected.startMonoNs)) ||
		(expected.endMonoNs != null && String(evidence.endMonoNs) !== String(expected.endMonoNs))
	)
		throw new Error('phase-boundary monotonic value mismatch');
	const marks = normalizeMarks(evidence.marks);
	const start = marks.find((mark) => mark.kind === 'phase-start');
	const end = marks.find((mark) => mark.kind === 'phase-end');
	if (!start || !end || start.monoNs !== String(evidence.startMonoNs) || end.monoNs !== String(evidence.endMonoNs))
		throw new Error('boundary marks do not match the observed phase times');
	const refs = evidence.sourceRefs;
	if (
		!Array.isArray(refs) ||
		refs.length !== marks.length ||
		refs.some(
			(ref, index) =>
				ref.kind !== marks[index].kind ||
				ref.path !== marks[index].sourcePath ||
				ref.sha256 !== marks[index].sourceSha256,
		)
	)
		throw new Error('phase-boundary sourceRefs do not match actual marks');
	if (expected.nowMonoNs != null && BigInt(evidence.endMonoNs) > BigInt(expected.nowMonoNs))
		throw new Error('phase end is later than the current monotonic clock');
	return {ok: true, startMonoNs: String(evidence.startMonoNs), endMonoNs: String(evidence.endMonoNs), sourceRefs: refs};
}

function normalizeMarks(value) {
	if (!Array.isArray(value) || value.length < 2)
		throw new Error('at least actual phase-start and phase-end marks are required');
	const seen = new Set();
	const result = value.map((mark) => {
		if (
			!['phase-start', 'phase-end'].includes(mark?.kind) ||
			seen.has(mark.kind) ||
			mark.observed !== true ||
			!DECIMAL_NS.test(String(mark.monoNs)) ||
			typeof mark.sourcePath !== 'string' ||
			!isPortablePath(mark.sourcePath) ||
			!SHA256.test(mark.sourceSha256 ?? '')
		)
			throw new Error('actual boundary mark identity/source is invalid');
		seen.add(mark.kind);
		return {
			kind: mark.kind,
			monoNs: String(mark.monoNs),
			observed: true,
			sourcePath: mark.sourcePath,
			sourceSha256: mark.sourceSha256,
		};
	});
	if (seen.size !== 2) throw new Error('both unique actual boundary marks are required');
	return result.sort((left, right) => (left.kind === 'phase-start' ? -1 : right.kind === 'phase-start' ? 1 : 0));
}

function isPortablePath(value) {
	return (
		value.length > 0 &&
		!value.includes('\\') &&
		!value.startsWith('/') &&
		value.split('/').every((part) => part && part !== '.' && part !== '..')
	);
}
