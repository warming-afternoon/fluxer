import cp from 'node:child_process';
import readline from 'node:readline';
import {readFileSync, readlinkSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
/** 读取 Linux PID 的启动身份，避免把复用的 PID 当成原容器进程。 */
export function namespaceIdentity(pid) {
	if (process.platform !== 'linux' || !Number.isInteger(pid) || pid < 1) throw Error('Linux namespace PID required');
	const stat = readFileSync('/proc/' + pid + '/stat', 'utf8');
	return {
		// PID 与启动身份共同识别当前进程。
		pid,

		// 内核启动标识用于排除跨启动周期的 PID 重用。
		bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),

		// startTicks 来自 proc stat，用于识别当前 PID 的启动时刻。
		startTicks: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19],
	};
}
/** 启动单个 HTTP 指标读取 worker，并逐次绑定请求身份与命名空间。 */
export function startMetricClient({port, namespace = null}) {
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Explicit metric port required');
	if (namespace) {
		const actual = namespaceIdentity(namespace.pid);
		if (actual.bootId !== namespace.bootId || actual.startTicks !== namespace.startTicks)
			throw Error('Metric namespace identity changed');
	}

	const expectedNetworkNamespace = namespace ? readlinkSync('/proc/' + namespace.pid + '/ns/net') : null;
	const worker = fileURLToPath(new URL('./MetricHttpWorker.mjs', import.meta.url));
	const command = namespace ? 'nsenter' : process.execPath;
	const args = namespace
		? ['-t', String(namespace.pid), '-n', '--', process.execPath, worker, String(port)]
		: [worker, String(port)];
	const child = cp.spawn(command, args, {stdio: ['pipe', 'pipe', 'pipe']});
	let sequence = 0,
		pending = null,
		stopping = false,
		stderrTail = '',
		terminal = null,
		closed = false,
		closeInfo = null,
		stopTask = null;
	let resolveClosed;
	const closedPromise = new Promise((resolve) => {
		resolveClosed = resolve;
	});
	/** 提取 worker 的进程状态，附在异常中帮助诊断。 */
	const details = () => ({
		pid: child.pid,
		exitCode: child.exitCode,
		signalCode: child.signalCode,
		killed: child.killed,
		stderrTail,
	});
	/** 保存终止错误并拒绝当前挂起请求。 */
	const fail = (error) => {
		// 首个终止错误同时结束当前读取，后续读取均会失败。
		terminal = error;
		if (pending) {
			clearTimeout(pending.timer);
			pending.reject(error);
			pending = null;
		}
	};
	child.stderr.on('data', (chunk) => {
		stderrTail = (stderrTail + chunk.toString()).slice(-512);
	});
	child.on('error', (error) => fail(Error('Metric helper spawn: ' + error.message)));
	child.on('close', (code, signal) => {
		closed = true;
		closeInfo = {code, signal, ...details()};
		resolveClosed(closeInfo);
		if (!stopping) fail(Error('Metric helper closed ' + JSON.stringify(closeInfo)));
	});
	child.stdin.on('error', (error) => {
		if (!stopping) fail(Error('Metric helper input: ' + error.message));
	});
	const lines = readline.createInterface({input: child.stdout, crlfDelay: Infinity});
	lines.on('line', (line) => {
		try {
			if (Buffer.byteLength(line) > 4 * 1024 * 1024) throw Error('Metric helper response too large');
			const row = JSON.parse(line);
			if (expectedNetworkNamespace && row.networkNamespace !== expectedNetworkNamespace)
				throw Error('Metric helper entered a different network namespace');
			if (!pending || row.id !== pending.id) throw Error('Metric helper response sequence mismatch');
			const current = pending;
			pending = null;
			clearTimeout(current.timer);
			const request = {
				...details(),

				// 保留请求序号及 worker 采集到的单调时钟边界。
				id: row.id,
				startNs: row.startNs,
				finishNs: row.finishNs,

				// 记录指标正文大小，便于复核响应是否被截断。
				bytes: row.bytes,
			};
			if (row.ok !== true)
				current.reject(Error('Metric HTTP failure ' + JSON.stringify({...request, error: row.error})));
			else if (!Number.isInteger(row.status) || typeof row.text !== 'string')
				current.reject(Error('Metric helper invalid HTTP response'));
			else current.resolve({status: row.status, text: row.text, request});
		} catch (error) {
			fail(error);
			child.kill('SIGTERM');
		}
	});
	return {
		/** 请求一次指标快照；同一 worker 同时只允许一个未完成请求。 */
		read() {
			if (stopping || terminal) return Promise.reject(terminal || Error('Metric reader stopped'));
			if (pending) return Promise.reject(Error('Metric request already pending'));
			return new Promise((resolve, reject) => {
				const id = ++sequence;
				const timer = setTimeout(() => {
					fail(Error('Metric helper deadline ' + JSON.stringify(details())));
					child.kill('SIGTERM');
				}, 1500);
				pending = {id, resolve, reject, timer};
				child.stdin.write(JSON.stringify({id}) + '\n');
			});
		},
		/** 关闭 worker 并报告其是否在没有异常退出的情况下结束。 */
		stop() {
			if (stopTask) return stopTask;
			stopTask = (async () => {
				const unexpectedError = terminal?.message || null;
				stopping = true;
				fail(Error('Metric reader stopped'));
				// 给 worker 有界时间退出，超时后先终止再强制结束。
				/** 等待 worker 在指定时间内结束。 */
				const wait = (ms) =>
					new Promise((resolve) => {
						const timer = setTimeout(() => resolve(false), ms);
						closedPromise.then(() => {
							clearTimeout(timer);
							resolve(true);
						});
					});
				if (!closed) {
					child.stdin.end();
					child.kill('SIGTERM');
				}
				let forced = false;
				if (!closed && !(await wait(3000))) {
					forced = true;
					child.kill('SIGKILL');
				}
				if (!closed && !(await wait(2000))) throw Error('Metric helper did not close ' + JSON.stringify(details()));
				return {ok: closed && !forced && !unexpectedError, forced, unexpectedError, ...closeInfo};
			})();
			return stopTask;
		},
		pid: child.pid,
	};
}
