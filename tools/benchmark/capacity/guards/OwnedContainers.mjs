// SPDX-License-Identifier: AGPL-3.0-or-later

import {execFileSync} from 'node:child_process';

/** 仅停止冻结清单中的完整容器ID，逐项校验镜像/项目/角色并读取停止后状态。 */
export function stopOwnedContainers(owner, {execute = execFileSync, gracefulSeconds = 60, timeoutMs = 120000} = {}) {
	if (
		!owner ||
		typeof owner.project !== 'string' ||
		!owner.project ||
		!Array.isArray(owner.services) ||
		!owner.services.length ||
		owner.services.length > 256 ||
		typeof execute !== 'function' ||
		!Number.isSafeInteger(gracefulSeconds) ||
		gracefulSeconds < 1 ||
		gracefulSeconds > 120 ||
		!Number.isSafeInteger(timeoutMs) ||
		timeoutMs <= gracefulSeconds * 1000 ||
		timeoutMs > 300000
	)
		throw Error('Explicit bounded container owner and stop configuration required');
	const services = owner.services.map(({id, imageId, role}) => {
		if (
			typeof id !== 'string' ||
			!/^[a-f0-9]{64}$/.test(id) ||
			typeof imageId !== 'string' ||
			!/^sha256:[a-f0-9]{64}$/.test(imageId) ||
			typeof role !== 'string' ||
			!role
		)
			throw Error('Full immutable container/image IDs and role required');
		return Object.freeze({id, imageId, role});
	});
	if (
		new Set(services.map((row) => row.id)).size !== services.length ||
		new Set(services.map((row) => row.role)).size !== services.length
	)
		throw Error('Unique owned container IDs and roles required');
	const project = owner.project;
	const ids = services.map((row) => row.id);
	/** 同一完整ID清单必须全部匹配，不按名称重找或接受额外容器。 */
	const inspect = () => {
		const rows = JSON.parse(
			execute('docker', ['inspect', ...ids], {encoding: 'utf8', timeout: timeoutMs, maxBuffer: 8 * 1024 ** 2}),
		);
		if (
			!Array.isArray(rows) ||
			rows.length !== services.length ||
			new Set(rows.map((row) => row.Id)).size !== rows.length
		)
			throw Error('Exact owned container inspection required');
		return rows.map((row) => {
			const spec = services.find((entry) => entry.id === row.Id);
			if (
				!spec ||
				row.Image !== spec.imageId ||
				row.Config?.Labels?.['com.docker.compose.project'] !== project ||
				row.Config?.Labels?.['com.docker.compose.service'] !== spec.role ||
				typeof row.State?.Running !== 'boolean'
			)
				throw Error('Container owner identity differs');
			return {
				id: spec.id,
				imageId: spec.imageId,
				role: spec.role,
				running: row.State.Running,
				status: row.State.Status ?? null,
			};
		});
	};
	const before = inspect();
	const running = before.filter((row) => row.running).map((row) => row.id);
	if (running.length)
		execute('docker', ['stop', '--timeout', String(gracefulSeconds), '--', ...running], {
			encoding: 'utf8',
			timeout: timeoutMs,
			maxBuffer: 1024 ** 2,
		});
	const after = inspect();
	if (after.some((row) => row.running)) throw Error('Owned container still running after stop');
	return {stopped: true, requestedIds: running, containers: after, cleanWebSocketCloseProven: false};
}
