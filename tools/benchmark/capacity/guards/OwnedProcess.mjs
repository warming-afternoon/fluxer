// SPDX-License-Identifier: AGPL-3.0-or-later

/** 通过稳定内核句柄或协作式实例句柄停止精确进程，不接受 PID-only kill 适配器。 */
export async function stopOwnedProcess(owner, {openHandle, timeoutMs, signal = 'SIGTERM'} = {}) {
	if (
		!owner ||
		!Number.isSafeInteger(owner.pid) ||
		owner.pid <= 0 ||
		typeof owner.bootId !== 'string' ||
		!owner.bootId ||
		typeof owner.startToken !== 'string' ||
		!owner.startToken ||
		typeof owner.runId !== 'string' ||
		!owner.runId
	)
		throw Error('Exact owned process identity required');
	if (
		typeof openHandle !== 'function' ||
		!Number.isSafeInteger(timeoutMs) ||
		timeoutMs <= 0 ||
		timeoutMs > 300000 ||
		signal !== 'SIGTERM'
	)
		throw Error('Explicit bounded graceful stop adapter required');
	// 适配器必须把身份查询和发信号绑定到同一实例；先查 /proc 再 kill(pid) 不满足契约。
	const expected = Object.freeze({...owner});
	const handle = await openHandle(expected);
	if (
		handle?.identityBound !== true ||
		typeof handle.inspect !== 'function' ||
		typeof handle.terminate !== 'function' ||
		typeof handle.waitForExit !== 'function' ||
		typeof handle.close !== 'function'
	) {
		await handle?.close?.();
		throw Error('Identity-bound process handle required');
	}
	try {
		const actual = await handle.inspect();
		for (const key of ['pid', 'bootId', 'startToken', 'runId']) {
			if (actual?.[key] !== expected[key]) throw Error(`Owned process identity differs: ${key}`);
		}
		if (typeof actual.running !== 'boolean') throw Error('Actual running state required');
		if (actual.running) await handle.terminate({signal, expected});
		const exit = await handle.waitForExit({timeoutMs, expected});
		for (const key of ['pid', 'bootId', 'startToken', 'runId']) {
			if (exit?.[key] !== expected[key]) throw Error(`Exit receipt identity differs: ${key}`);
		}
		if (exit.running !== false || exit.confirmed !== true) throw Error('Owned process stop not confirmed');
		return {identity: expected, stopped: true, alreadyStopped: !actual.running, exit};
	} finally {
		await handle.close();
	}
}
