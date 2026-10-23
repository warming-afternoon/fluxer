// One external HTTP reader in the verified push container's network namespace.
import http from 'node:http';
import readline from 'node:readline';
import {readlinkSync} from 'node:fs';
const networkNamespace = process.platform === 'linux' ? readlinkSync('/proc/self/ns/net') : null;
const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Explicit port required');
const input = readline.createInterface({input: process.stdin, crlfDelay: Infinity});
let active = null;
input.on('line', (line) => {
	// worker 只接收串行 ID 请求，响应带回实际进入的网络命名空间。
	const {id} = JSON.parse(line),
		startNs = process.hrtime.bigint().toString();
	if (!Number.isSafeInteger(id) || active) throw Error('Invalid or concurrent request');
	let ended = false,
		bytes = 0,
		chunks = [];
	/** 只发送一次结果，并释放当前请求的总时限。 */
	const finish = (value) => {
		if (ended) return;
		ended = true;
		clearTimeout(totalTimer);
		active = null;
		process.stdout.write(
			JSON.stringify({
				// ID 对应父进程发出的唯一未完成请求。
				id,

				// 返回 worker 实际使用的网络命名空间身份。
				networkNamespace,

				// 单调时钟边界用于计算本次 HTTP 读取时长。
				startNs,

				finishNs: process.hrtime.bigint().toString(),

				// 包含真实 HTTP 状态、正文或失败原因。
				...value,
			}) + '\n',
		);
	};
	const request = http.get({host: '127.0.0.1', port, path: '/_metrics', agent: false}, (response) => {
		response.on('data', (chunk) => {
			bytes += chunk.length;
			if (bytes > 512 * 1024) request.destroy(Error('Metric body exceeds 512 KiB'));
			else chunks.push(chunk);
		});
		response.on('error', (error) => finish({ok: false, error: error.message}));
		response.on('end', () =>
			finish({ok: true, status: response.statusCode, text: Buffer.concat(chunks).toString('utf8'), bytes}),
		);
	});
	active = request;
	const totalTimer = setTimeout(() => request.destroy(Error('Metric request exceeded 900 ms')), 900);
	request.on('socket', (socket) => {
		const connectTimer = setTimeout(() => request.destroy(Error('Metric connect exceeded 500 ms')), 500);
		socket.once('connect', () => clearTimeout(connectTimer));
		socket.once('close', () => clearTimeout(connectTimer));
	});
	request.on('error', (error) => finish({ok: false, error: error.message}));
});
input.on('close', () => {
	active?.destroy();
	process.exit(0);
});
