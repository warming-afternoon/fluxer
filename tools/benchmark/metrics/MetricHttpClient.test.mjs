// Isolated HTTP fixture only; no benchmark service or business load.
import http from 'node:http';
import assert from 'node:assert/strict';
import {namespaceIdentity, startMetricClient} from './MetricHttpClient.mjs';
let mode = 'metrics',
	requests = 0;
const sockets = new Set();
const server = http.createServer((request, response) => {
	requests++;
	if (mode === 'hang') return;
	if (mode === 'large') {
		response.end('x'.repeat(512 * 1024 + 1));
		return;
	}
	if (mode === 'empty') {
		response.writeHead(200);
		response.end();
		return;
	}
	if (mode === '500') {
		response.writeHead(500);
		response.end('failed');
		return;
	}
	response.end('fluxer_push_jobs_received_total 1\nfluxer_push_jobs_completed_total 1\nfluxer_push_queue_depth 0\n');
});
server.on('connection', (socket) => {
	sockets.add(socket);
	socket.once('close', () => sockets.delete(socket));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port,
	client = startMetricClient({port});
const checks = [];
try {
	for (let n = 0; n < 150; n++) {
		const row = await client.read();
		assert.equal(row.status, 200);
		assert.match(row.text, /fluxer_push_queue_depth/);
		assert.equal(row.request.id, n + 1);
		assert.ok(BigInt(row.request.finishNs) >= BigInt(row.request.startNs));
	}
	checks.push('150 sequential complete HTTP reads with request timing and identity');
	mode = 'empty';
	const empty = await client.read();
	assert.equal(empty.status, 200);
	assert.equal(empty.text, '');
	checks.push('empty HTTP body keeps real status rather than missing trailer');
	mode = '500';
	assert.equal((await client.read()).status, 500);
	checks.push('HTTP 500 remains HTTP 500');
	mode = 'hang';
	await assert.rejects(client.read(), /900 ms/);
	checks.push('900 ms request deadline fails without retry');
	mode = 'large';
	await assert.rejects(client.read(), /512 KiB/);
	checks.push('oversized body fails');
	mode = 'metrics';
	assert.equal((await client.read()).status, 200);
	checks.push('next read works; observer cumulative errors remain independently enforced');
	process.kill(client.pid, 'SIGKILL');
	await new Promise((resolve) => setTimeout(resolve, 100));
	await assert.rejects(client.read(), /closed/);
	checks.push('helper death is an error with exit/signal details');
	assert.equal((await client.stop()).ok, false);
	const tail = startMetricClient({port});
	assert.equal((await tail.read()).status, 200);
	process.kill(tail.pid, 'SIGKILL');
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal((await tail.stop()).ok, false);
	checks.push('unexpected exit before cleanup fails even without a following read');
	if (process.platform === 'linux') {
		const identity = namespaceIdentity(process.pid);
		assert.throws(() => startMetricClient({port, namespace: {...identity, startTicks: 'stale'}}), /identity changed/);
		const namespaced = startMetricClient({port, namespace: identity});
		assert.equal((await namespaced.read()).status, 200);
		assert.equal((await namespaced.stop()).ok, true);
		checks.push('Linux PID start identity and actual entered network namespace verified');
	}
	console.log(JSON.stringify({ok: true, checks, requests, businessServicesStarted: false}));
} finally {
	await client.stop();
	for (const socket of sockets) socket.destroy();
	await new Promise((resolve) => server.close(resolve));
}
