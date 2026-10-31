// SPDX-License-Identifier: AGPL-3.0-or-later

/** 拒绝错误启动身份、未来或过期样本，阈值由唯一运行配置传入。 */
export function assertFreshResourceSample(
	sample,
	{bootId, nowNs, maxAgeNs, minimumAvailableBytes = {}, expectedProcessIds = []} = {},
) {
	if (typeof bootId !== 'string' || !bootId || sample?.bootId !== bootId)
		throw Error('Resource sample boot identity differs');
	const values = [sample.monoNs, nowNs, maxAgeNs];
	if (values.some((value) => typeof value !== 'bigint' && (typeof value !== 'string' || !/^\d+$/.test(value))))
		throw Error('Exact nanosecond timestamps required');
	const age = BigInt(nowNs) - BigInt(sample.monoNs),
		maxAge = BigInt(maxAgeNs);
	if (BigInt(sample.monoNs) < 0n || maxAge <= 0n || age < 0n || age > maxAge)
		throw Error('Fresh complete resource sample required');
	if (
		!Array.isArray(expectedProcessIds) ||
		new Set(expectedProcessIds).size !== expectedProcessIds.length ||
		expectedProcessIds.some((id) => typeof id !== 'string' || !id)
	)
		throw Error('Explicit unique process identity list required');
	const actual = sample.processIds;
	if (
		expectedProcessIds.length &&
		(!Array.isArray(actual) ||
			actual.length !== expectedProcessIds.length ||
			new Set(actual).size !== actual.length ||
			expectedProcessIds.some((id) => !actual.includes(id)))
	)
		throw Error('Resource process identity set differs');
	for (const [resource, minimum] of Object.entries(minimumAvailableBytes)) {
		const actualBytes = sample.availableBytes?.[resource];
		if (!Number.isSafeInteger(minimum) || minimum < 0 || !Number.isSafeInteger(actualBytes) || actualBytes < minimum)
			throw Error(`Available resource gate failed: ${resource}`);
	}
	if (sample.errors?.length || sample.complete !== true || sample.oomKilled === true)
		throw Error('Incomplete or failed resource collection');
	return {ageNs: String(age), bootId, complete: true};
}

/** 仅在完整原规则均通过后计算额外线性余量筛查，不把预测当成容量证明。 */
export function assessHeadroom({
	before,
	after,
	currentRate,
	nextRate,
	limitsByRole,
	originalMayContinue,
	resourceCoverage,
	resourceSafe,
	deliveryVerified,
	webSocketVerified,
	actualUnique,
	expectedUnique,
	missingUnique,
} = {}) {
	if (
		!Number.isFinite(currentRate) ||
		currentRate <= 0 ||
		!Number.isFinite(nextRate) ||
		nextRate < currentRate ||
		!limitsByRole ||
		!Object.keys(limitsByRole).length
	)
		throw Error('Explicit rates and role CPU limits required');
	if (!before?.bootId || before.bootId !== after?.bootId) throw Error('Resource window boot identity differs');
	const exact = (value) => {
		if (typeof value !== 'bigint' && (typeof value !== 'string' || !/^\d+$/.test(value)))
			throw Error('Exact nonnegative CPU counter required');
		const number = BigInt(value);
		if (number < 0n) throw Error('Negative counter');
		return number;
	};
	const elapsed = exact(after.monoNs) - exact(before.monoNs);
	if (elapsed <= 0n) throw Error('Positive resource window required');
	if (![before.roles, after.roles].every(Array.isArray)) throw Error('CPU role samples required');
	for (const rows of [before.roles, after.roles]) {
		if (rows.length > 1000 || new Set(rows.map((row) => row.role)).size !== rows.length)
			throw Error('Unique bounded CPU roles required');
	}
	const scale = nextRate / currentRate;
	const projectedCores = {},
		observedCores = {};
	for (const [role, limit] of Object.entries(limitsByRole)) {
		const first = before.roles.find((row) => row.role === role),
			last = after.roles.find((row) => row.role === role);
		if (
			!Number.isFinite(limit) ||
			limit <= 0 ||
			typeof first?.identity !== 'string' ||
			!first.identity ||
			!Number.isSafeInteger(first.restartCount) ||
			first.restartCount < 0 ||
			first.identity !== last?.identity ||
			first.restartCount !== last.restartCount
		)
			throw Error(`CPU role identity or limit invalid: ${role}`);
		const usage = exact(last.cpuUsageNs) - exact(first.cpuUsageNs);
		if (usage < 0n) throw Error('CPU counter decreased');
		// 只把计数差/区间转换为比例，绝不先舍入绝对纳秒时间戳。
		const cores = Number(usage) / Number(elapsed);
		if (!Number.isFinite(cores) || !Number.isFinite(cores * scale)) throw Error('CPU ratio is not finite');
		observedCores[role] = cores;
		projectedCores[role] = cores * scale;
	}
	const exactCount = exact(actualUnique) === exact(expectedUnique) && exact(missingUnique) === 0n;
	const gates = [originalMayContinue, resourceCoverage, resourceSafe, deliveryVerified, webSocketVerified].every(
		(value) => value === true,
	);
	return {
		mayAdvance:
			gates && exactCount && Object.entries(projectedCores).every(([role, cores]) => cores < limitsByRole[role]),
		observedCores,
		projectedCores,
		forecastScale: scale,
		originalRulesPassed: gates && exactCount,
		scope:
			'Additional conservative linear screening, not capacity proof; original quality and resource gates remain required.',
	};
}
