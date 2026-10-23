// SPDX-License-Identifier: AGPL-3.0-or-later
import fs from 'node:fs';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
export function renderMultiApi(compose, template, options = {}) {
	const count = Number(
		options.instances ??
			process.env.FLUXER_API_INSTANCES ??
			compose.services.api?.environment?.FLUXER_API_INSTANCES ??
			2,
	);
	if (!Number.isSafeInteger(count) || count < 1 || count > 512)
		throw Error('API instance count must be an integer in 1..512');
	const totalMemoryMiB = count * 1536,
		hostMemoryMiB = Math.floor((options.hostMemoryBytes ?? os.totalmem()) / 1048576);
	if (totalMemoryMiB > hostMemoryMiB * 0.4)
		throw Error('API limits exceed 40% host RAM: reserve memory for Cassandra, Caddy, gateway and OS');
	if (/Authorization|Bearer|@bench|[a-f0-9]{64}/i.test(template))
		throw Error('Use the clean Caddy template, never a test-account routing map');
	const result = structuredClone(compose),
		api = structuredClone(result.services.api);
	if (!api) throw Error('Missing api service');
	const roles = Array.from({length: count}, (_, i) => (i === 0 ? 'api' : i === 1 ? 'api-b' : 'api-' + (i + 1)));
	for (const key of Object.keys(result.services)) if (/^api(?:-b|-\d+)?$/.test(key)) delete result.services[key];
	const rpcUrls = roles.map((n) => 'http://' + n + ':8080/internal/rpc').join(',');
	for (const [i, role] of roles.entries()) {
		const svc = structuredClone(api);
		delete svc.container_name;
		if (i) delete svc.ports;
		const env = (svc.environment ??= {});
		for (const key of ['FLUXER_BENCH_SESSION_ACTIVITY_CACHE_ENABLED', 'FLUXER_BENCH_KV_PIPELINE_ENABLED'])
			delete env[key];
		Object.assign(env, {
			FLUXER_API_INSTANCES: String(count),
			FLUXER_API_MAX_INFLIGHT_REQUESTS: String(Math.floor(512 / count) + (i < 512 % count ? 1 : 0)),
		});
		env.NODE_OPTIONS =
			(env.NODE_OPTIONS ?? '').replace(/--max-old-space-size(?:=|\s+)\d+/g, '').trim() + ' --max-old-space-size=1024';
		env.FLUXER_API_INSTANCE_ID = role;
		svc.deploy ??= {};
		svc.deploy.resources ??= {};
		svc.deploy.resources.limits ??= {};
		svc.deploy.resources.limits.memory = String(1536 * 1048576);
		svc.healthcheck = {
			test: [
				'CMD',
				'node',
				'-e',
				"fetch('http://127.0.0.1:8080/_ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
			],
			interval: '2s',
			timeout: '1s',
			retries: 2,
			start_period: '180s',
		};
		result.services[role] = svc;
	}
	for (const [name, svc] of Object.entries(result.services)) {
		if (['gateway', 'push', 'worker'].includes(name)) {
			svc.environment ??= {};
			svc.environment.FLUXER_INTERNAL_API_RPC_URLS = rpcUrls;
			delete svc.environment.FLUXER_BENCH_RPC_DIRECT_URLS;
			delete svc.environment.FLUXER_BENCH_RPC_DIRECT_ENABLED;
		}
		if (svc.depends_on) {
			for (const role of Object.keys(svc.depends_on)) if (/^api(?:-b|-\d+)?$/.test(role)) delete svc.depends_on[role];
			if (['edge', 'gateway', 'push', 'worker'].includes(name))
				for (const role of roles) svc.depends_on[role] = {condition: 'service_healthy', required: true};
		}
	}
	const block =
		'reverse_proxy ' +
		roles.map((n) => n + ':8080').join(' ') +
		' {\n lb_policy least_conn\n lb_retries 0\n health_uri /_ready\n health_interval 2s\n health_timeout 1s\n health_fails 2\n health_passes 2\n}';
	const caddy = template.replace(/reverse_proxy api:8080/g, block);
	if (caddy === template) throw Error('API reverse proxy template missing');
	result.services.edge.deploy ??= {};
	result.services.edge.deploy.resources ??= {};
	result.services.edge.deploy.resources.limits ??= {};
	result.services.edge.deploy.resources.limits.memory = String(1792 * 1048576);
	result.services.edge.environment ??= {};
	result.services.edge.environment.GOMEMLIMIT = '1536MiB';
	const budget = {
		instances: count,
		roles,
		apiMemoryPerMiB: 1536,
		apiMemoryTotalMiB: totalMemoryMiB,
		apiHeapPerMiB: 1024,
		apiHeapTotalMiB: count * 1024,
		totalConcurrency: 512,
		hostMemoryMiB,
	};
	return {compose: result, caddy, budget};
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const args = {};
	for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
	for (const k of ['input', 'output', 'caddy-template', 'caddy-output']) if (!args[k]) throw Error('Missing --' + k);
	const rendered = renderMultiApi(
		JSON.parse(fs.readFileSync(args.input, 'utf8')),
		fs.readFileSync(args['caddy-template'], 'utf8'),
		{instances: args.instances},
	);
	const vols = rendered.compose.services.edge.volumes ?? [];
	for (const v of vols) if (typeof v === 'object' && /Caddyfile$/.test(v.target ?? '')) v.source = args['caddy-output'];
	fs.writeFileSync(args['caddy-output'], rendered.caddy, {mode: 0o600});
	fs.writeFileSync(args.output, JSON.stringify(rendered.compose, null, 2), {mode: 0o600});
	console.log(JSON.stringify(rendered.budget));
}
