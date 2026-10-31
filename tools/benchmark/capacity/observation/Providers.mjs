// SPDX-License-Identifier: AGPL-3.0-or-later
import {monitorEventLoopDelay} from 'node:perf_hooks';

/** 显式预算校验，禁止非有限值和隐式无限采集。 */
function bounded(value, max, name) {
	if (!Number.isSafeInteger(value) || value < 1 || value > max) throw Error(`Invalid ${name}`);
	return value;
}
/** 只提取配置声明的有限数字；缺项保留为空，不能转成零。 */
function project(document, fields) {
	const metrics = {};
	for (const [name, parts] of Object.entries(fields)) {
		let value = document;
		for (const part of parts) value = value && Object.hasOwn(value, part) ? value[part] : undefined;
		if (typeof value === 'number' && Number.isFinite(value)) metrics[name] = value;
	}
	return {metrics};
}
/** 校验字段白名单，避免把凭证、账号或整个端点响应写入证据。 */
function validateFields(fields) {
	if (!fields || Object.keys(fields).length < 1 || Object.keys(fields).length > 128)
		throw Error('Explicit bounded metric fields required');
	for (const [name, parts] of Object.entries(fields)) {
		if (
			!/^[a-zA-Z][\w.-]{0,127}$/.test(name) ||
			!Array.isArray(parts) ||
			!parts.length ||
			parts.length > 16 ||
			parts.some(
				(p) => typeof p !== 'string' || !p || p.length > 128 || ['__proto__', 'constructor', 'prototype'].includes(p),
			)
		)
			throw Error('Invalid metric field path');
	}
}
/** 有界只读 HTTP JSON 采样；不记录 URL、请求头或未筛选正文。 */
export function createHttpJsonProvider({
	id,
	url,
	headers = {},
	fields,
	timeoutMs,
	maxResponseBytes,
	fetchImpl = globalThis.fetch,
	sourceClockDomain,
	timestampPath,
	sourceIdentityPath,
	expectedSourceIdentity,
}) {
	const endpoint = new URL(url);
	if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash)
		throw Error('Explicit HTTP(S) endpoint without embedded credentials required');
	bounded(timeoutMs, 60000, 'HTTP timeout');
	bounded(maxResponseBytes, 4 * 1024 ** 2, 'HTTP response budget');
	validateFields(fields);
	return {
		id,
		async read() {
			const controller = new AbortController();
			let timer;
			const expired = new Promise((_, reject) => {
				timer = setTimeout(() => {
					controller.abort();
					reject(Error('HTTP observation timeout'));
				}, timeoutMs);
			});
			const request = (async () => {
				const response = await fetchImpl(endpoint.href, {
					method: 'GET',
					headers,
					redirect: 'error',
					signal: controller.signal,
				});
				if (!response.ok || !response.body?.getReader) throw Error('HTTP observation response unavailable');
				const reader = response.body.getReader();
				const chunks = [];
				let bytes = 0;
				try {
					while (true) {
						const part = await reader.read();
						if (part.done) break;
						bytes += part.value.byteLength;
						if (bytes > maxResponseBytes) throw Error('HTTP observation response budget exceeded');
						chunks.push(Buffer.from(part.value));
					}
				} finally {
					await reader.cancel().catch(() => {});
				}
				const document = JSON.parse(Buffer.concat(chunks).toString('utf8'));
				const result = project(document, fields);
				let identity = document;
				if (Array.isArray(sourceIdentityPath)) for (const part of sourceIdentityPath) identity = identity?.[part];
				result.sourceIdentityVerified =
					typeof expectedSourceIdentity === 'string' &&
					expectedSourceIdentity.length > 0 &&
					Array.isArray(sourceIdentityPath) &&
					identity === expectedSourceIdentity;
				if (sourceClockDomain && Array.isArray(timestampPath)) {
					let timestamp = document;
					for (const part of timestampPath) timestamp = timestamp?.[part];
					result.sourceTimestampNs = timestamp;
					result.sourceClockDomain = sourceClockDomain;
				}
				return result;
			})();
			try {
				return await Promise.race([request, expired]);
			} finally {
				clearTimeout(timer);
				controller.abort();
			}
		},
	};
}
/** 复用调用方已经拥有的 MetricHttpClient.read，不创建/停止任何进程。 */
export function createMetricReaderProvider({
	id,
	reader,
	fields,
	maxResponseBytes,
	sourceClockDomain,
	timestampPath,
	sourceIdentityPath,
	expectedSourceIdentity,
}) {
	validateFields(fields);
	bounded(maxResponseBytes, 4 * 1024 ** 2, 'reader response budget');
	if (typeof reader?.read !== 'function') throw Error('Owned metric reader required');
	return {
		id,
		async read() {
			const result = await reader.read();
			if (result.status !== 200 || typeof result.text !== 'string' || Buffer.byteLength(result.text) > maxResponseBytes)
				throw Error('Metric reader response rejected');
			const document = JSON.parse(result.text),
				data = project(document, fields);
			let identity = document;
			if (Array.isArray(sourceIdentityPath)) for (const part of sourceIdentityPath) identity = identity?.[part];
			data.sourceIdentityVerified =
				typeof expectedSourceIdentity === 'string' &&
				expectedSourceIdentity.length > 0 &&
				Array.isArray(sourceIdentityPath) &&
				identity === expectedSourceIdentity;
			if (sourceClockDomain && Array.isArray(timestampPath)) {
				let timestamp = document;
				for (const part of timestampPath) timestamp = timestamp?.[part];
				data.sourceTimestampNs = timestamp;
				data.sourceClockDomain = sourceClockDomain;
			}
			return data;
		},
	};
}
/** 仅观察本 Node 进程；不把本进程 CPU 当作网关、虚拟机或业务 CPU。 */
export function createNodeProcessProvider({
	id,
	generatorProcess = false,
	clockDomain,
	resolutionMs,
	nowNs = process.hrtime.bigint,
	cpuUsage = process.cpuUsage,
	memoryUsage = process.memoryUsage,
	histogramFactory = monitorEventLoopDelay,
}) {
	if (typeof generatorProcess !== 'boolean') throw Error('Explicit generator process flag required');
	bounded(resolutionMs, 1000, 'event loop resolution');
	if (typeof clockDomain !== 'string' || !clockDomain) throw Error('Own process clock domain required');
	let histogram, previous;
	return {
		id,
		generatorProcess,
		start() {
			if (histogram) throw Error('Node observer already active');
			histogram = histogramFactory({resolution: resolutionMs});
			histogram.enable();
			previous = {ns: nowNs(), cpu: cpuUsage()};
		},
		read() {
			if (!histogram) throw Error('Node observer not started');
			const ns = nowNs(),
				cpu = cpuUsage(),
				memory = memoryUsage();
			const metrics = {'node.rssBytes': memory.rss, 'node.heapUsedBytes': memory.heapUsed};
			const wall = ns - previous.ns;
			if (wall > 0n)
				metrics['node.cpuPercent'] =
					((cpu.user - previous.cpu.user + cpu.system - previous.cpu.system) * 100000) / Number(wall);
			if (histogram.count > 0) metrics['node.loopP99Ms'] = histogram.percentile(99) / 1e6;
			const interval = {startNs: String(previous.ns), endNs: String(ns), clockDomain};
			previous = {ns, cpu};
			histogram.reset();
			return {
				metrics,
				interval,
				sourceTimestampNs: String(ns),
				sourceClockDomain: clockDomain,
				scope: 'observer-node-process-only',
				generatorProcess,
			};
		},
		stop() {
			histogram?.disable();
			histogram = null;
			previous = null;
		},
	};
}
