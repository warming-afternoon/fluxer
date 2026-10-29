// SPDX-License-Identifier: AGPL-3.0-or-later
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {renderMultiApi} from '../self-hosting/render-multi-api.mjs';

/** 显式选择多实例时沿用上游路由生成器，保留社区正式部署的资源上限。 */
export function renderOdysseia(compose, template, {instances = 1, hostMemoryMiB} = {}) {
	if (!Number.isFinite(hostMemoryMiB) || hostMemoryMiB <= 0) throw Error('Explicit target hostMemoryMiB required');
	if (!Number.isSafeInteger(Number(instances)) || Number(instances) < 1 || Number(instances) > 512)
		throw Error('API instance count must be an integer in 1..512');
	const memory = Number(compose.services.api?.deploy?.resources?.limits?.memory);
	if (!Number.isFinite(memory) || memory <= 0)
		throw Error('Input must be resolved Docker Compose JSON with memory in bytes');
	if (memory * Number(instances) > hostMemoryMiB * 1048576 * 0.4)
		throw Error('API limits exceed 40% of target host RAM');
	// 上游渲染器按固定1536MiB校验；资源预算已按本社区真实配置校验，不让其默认值误拒合法的小实例。
	const rendererMemoryMiB = Math.max(hostMemoryMiB, (Number(instances) * 1536) / 0.4);
	const rendered = renderMultiApi(compose, template, {instances, hostMemoryBytes: rendererMemoryMiB * 1048576});
	for (const role of rendered.budget.roles) {
		rendered.compose.services[role].deploy.resources = structuredClone(compose.services.api.deploy.resources);
		rendered.compose.services[role].environment.NODE_OPTIONS = compose.services.api.environment.NODE_OPTIONS;
	}
	rendered.compose.services.edge.deploy = structuredClone(compose.services.edge.deploy);
	rendered.compose.services.edge.environment = structuredClone(compose.services.edge.environment);
	for (const [name, service] of Object.entries(compose.services)) {
		if (service.depends_on?.api) {
			for (const role of rendered.budget.roles) {
				rendered.compose.services[name].depends_on[role] = {condition: 'service_healthy', required: true};
			}
		}
	}
	rendered.budget.apiMemoryPerMiB = memory / 1048576;
	rendered.budget.apiMemoryTotalMiB = (memory * Number(instances)) / 1048576;
	rendered.budget.hostMemoryMiB = hostMemoryMiB;
	delete rendered.budget.apiHeapPerMiB;
	delete rendered.budget.apiHeapTotalMiB;
	return rendered;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const args = {};
	for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
	for (const name of ['input', 'output', 'caddy-output', 'host-memory-mib', 'instances'])
		if (!args[name]) throw Error(`Missing --${name}`);
	const rendered = renderOdysseia(
		JSON.parse(fs.readFileSync(args.input, 'utf8')),
		fs.readFileSync(new URL('./Caddyfile', import.meta.url), 'utf8'),
		{
			instances: Number(args.instances),
			hostMemoryMiB: Number(args['host-memory-mib']),
		},
	);
	for (const volume of rendered.compose.services.edge.volumes ?? []) {
		if (typeof volume === 'object' && volume.target === '/etc/caddy/Caddyfile') volume.source = args['caddy-output'];
	}
	fs.writeFileSync(args['caddy-output'], rendered.caddy, {mode: 0o600});
	fs.writeFileSync(args.output, JSON.stringify(rendered.compose, null, 2), {mode: 0o600});
	console.log(JSON.stringify(rendered.budget));
}
