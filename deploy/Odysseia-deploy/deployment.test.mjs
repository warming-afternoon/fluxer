// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {renderOdysseia} from './render-multi-api.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '../..');
const require = createRequire(import.meta.url);

/** 从本地已安装依赖加载 YAML，兼容 npm 提升和 pnpm 工作区，不依赖开发机绝对路径。 */
function loadYaml() {
	try {
		return require('yaml');
	} catch {}
	const store = path.join(root, 'node_modules/.pnpm');
	for (const entry of fs.existsSync(store) ? fs.readdirSync(store) : []) {
		if (!entry.startsWith('yaml@')) continue;
		return require(path.join(store, entry, 'node_modules/yaml'));
	}
	throw new Error('Install workspace dependencies (yaml package required) before running deployment tests');
}

const yaml = loadYaml();
const document = yaml.parseDocument(fs.readFileSync(path.join(directory, 'docker-compose.yml'), 'utf8'), {
	merge: true,
	uniqueKeys: true,
});
assert.deepEqual(document.errors, []);
const compose = document.toJS();
const template = fs.readFileSync(path.join(directory, 'Caddyfile'), 'utf8');

/** 为渲染器构造 Compose JSON 中已经按字节规范化的资源字段。 */
function resolvedFixture(memoryMiB = 2560) {
	const result = structuredClone(compose);
	result.services.api.deploy.resources.limits.memory = String(memoryMiB * 1048576);
	result.services.api.deploy.resources.reservations.memory = String(1024 * 1048576);
	result.services.api.environment.NODE_OPTIONS = '--enable-source-maps --max-old-space-size=2048';
	result.services.edge.deploy.resources.limits.memory = String(1792 * 1048576);
	result.services.edge.environment.GOMEMLIMIT = '1536MiB';
	return result;
}

test('YAML 合并后的所有数据库配置均为 Cassandra 且无 PostgreSQL 服务', () => {
	const consumers = Object.values(compose.services).filter((service) => service.environment?.FLUXER_DATABASE_BACKEND);
	assert.ok(consumers.length >= 10);
	for (const service of consumers) {
		assert.equal(service.environment.FLUXER_DATABASE_BACKEND, 'cassandra');
		assert.ok(service.environment.FLUXER_CASSANDRA_HOSTS);
		assert.equal(
			Object.keys(service.environment).some((key) => key.startsWith('FLUXER_POSTGRES')),
			false,
		);
	}
	assert.equal(compose.services.postgres, undefined);
	assert.deepEqual(compose.services.cassandra.profiles, ['bundled-cassandra']);
});

test('依赖目标存在、无启动环路、外部 Cassandra 模式允许禁用本地服务', () => {
	const visited = new Set();
	const visiting = new Set();
	const visit = (name) => {
		assert.ok(compose.services[name], `Missing dependency ${name}`);
		assert.ok(!visiting.has(name), `Dependency cycle at ${name}`);
		if (visited.has(name)) return;
		visiting.add(name);
		for (const [dependency, options] of Object.entries(compose.services[name].depends_on ?? {})) {
			if (dependency === 'cassandra') assert.equal(options.required, false);
			visit(dependency);
		}
		visiting.delete(name);
		visited.add(name);
	};
	for (const name of Object.keys(compose.services)) visit(name);
});

test('社区 API、worker、integration、gateway、push 均构建本分叉镜像', () => {
	for (const name of ['api', 'worker', 'fluxer-integration', 'gateway', 'push']) {
		const service = compose.services[name];
		assert.match(service.image, /^fluxer-local\//);
		assert.match(service.image, /FLUXER_PRODUCT_BUILD_TAG/);
		const context = path.resolve(directory, service.build.context);
		assert.equal(context, root);
		assert.ok(fs.existsSync(path.join(context, service.build.dockerfile)));
		assert.match(service.build.args.SOURCE_SHA, /FLUXER_SOURCE_SHA/);
	}
	assert.deepEqual(compose.services['fluxer-integration'].command, ['node', 'dist/IntegrationEntrypoint.js']);
	assert.deepEqual(compose.services.worker.command, ['node', 'dist/WorkerEntrypoint.js']);
});

test('外部总线隔离监听且各运行角色使用独立凭据', () => {
	const broker = compose.services['nats-integration'];
	// biome-ignore lint/suspicious/noTemplateCurlyInString: 校验 Compose 原始插值表达式。
	assert.deepEqual(broker.ports, ['${INTEGRATION_WG_IP:?set Fluxer WireGuard IP}:4223:4222']);
	assert.equal(Object.keys(broker.environment).length, 6);
	const users = ['api', 'worker', 'fluxer-integration'].map(
		(name) => compose.services[name].environment.INTEGRATION_NATS_USER,
	);
	assert.equal(new Set(users).size, 3);
	for (const name of ['api', 'worker', 'fluxer-integration']) {
		const environment = compose.services[name].environment;
		assert.equal(environment.INTEGRATION_NATS_URL, 'nats://nats-integration:4222');
		assert.notEqual(environment.FLUXER_NATS_URL, environment.INTEGRATION_NATS_URL);
	}
	const acl = fs.readFileSync(path.join(directory, 'nats/integration.conf'), 'utf8');
	assert.match(acl, /user: "fluxer-worker", password: \$INTEGRATION_WORKER_PASSWORD/);
	assert.match(acl, /allow_responses: \{max: 1, expires: "30s"\}/);
});

test('集成健康检查指向独立端口且不对宿主机发布', () => {
	const service = compose.services['fluxer-integration'];
	assert.equal(service.environment.INTEGRATION_HEALTH_PORT, '8091');
	assert.match(service.healthcheck.test.at(-1), /8091\/_ready/);
	assert.equal(service.ports, undefined);
	assert.equal(service.depends_on['nats-integration'].condition, 'service_healthy');
});

test('Bot 仅增加双向服务健康探测，不获得会话 RPC 权限', () => {
	const acl = fs.readFileSync(path.join(directory, 'nats/integration.conf'), 'utf8');
	const bot = acl.slice(acl.indexOf('user: "discord-sync"'), acl.indexOf('user: "fluxer-integration"'));
	assert.match(bot, /"rpc\.forum\.v1\.service_info"/);
	assert.match(bot, /"rpc\.integration\.v1\.service_info"/);
	assert.match(bot, /subscribe: \{allow: \["_INBOX\.bot\.>"\]\}/);
	assert.doesNotMatch(bot, /rpc\.auth\.|_INBOX\.forum|\$JS\.API/);
	const forum = acl.slice(acl.indexOf('user: "forum-service"'), acl.indexOf('user: "discord-sync"'));
	assert.match(forum, /"rpc\.forum\.v1\.service_info"/);
	assert.match(forum, /allow_responses: \{max: 1, expires: "5s"\}/);
});

test('首次部署及生成器默认均为单 API，多实例仅由显式参数启用', () => {
	assert.deepEqual(
		Object.keys(compose.services).filter((name) => /^api(?:-b|-\d+)?$/.test(name)),
		['api'],
	);
	// biome-ignore lint/suspicious/noTemplateCurlyInString: 校验 Compose 默认值而非 JavaScript 插值。
	assert.equal(compose.services.api.environment.FLUXER_API_INSTANCES, '${FLUXER_API_INSTANCES:-1}');
	assert.match(fs.readFileSync(path.join(directory, '.env.example'), 'utf8'), /^FLUXER_API_INSTANCES=1$/m);
	const rendered = renderOdysseia(resolvedFixture(), template, {hostMemoryMiB: 16384});
	assert.deepEqual(rendered.budget.roles, ['api']);
	assert.equal(rendered.budget.instances, 1);
});

test('多 API 渲染保留社区内存、预留、heap、edge 环境与依赖', () => {
	const source = resolvedFixture();
	const before = structuredClone(source);
	const rendered = renderOdysseia(source, template, {instances: 2, hostMemoryMiB: 16384});
	assert.deepEqual(source, before);
	for (const role of ['api', 'api-b']) {
		assert.deepEqual(rendered.compose.services[role].deploy.resources, source.services.api.deploy.resources);
		assert.equal(
			rendered.compose.services[role].environment.NODE_OPTIONS,
			source.services.api.environment.NODE_OPTIONS,
		);
		assert.equal(rendered.compose.services['app-proxy'].depends_on[role].condition, 'service_healthy');
	}
	assert.deepEqual(rendered.compose.services.edge.deploy, source.services.edge.deploy);
	assert.deepEqual(rendered.compose.services.edge.environment, source.services.edge.environment);
	assert.equal(rendered.budget.apiMemoryTotalMiB, 5120);
	assert.equal(rendered.budget.hostMemoryMiB, 16384);
	assert.match(rendered.caddy, /reverse_proxy api:8080 api-b:8080/);
	assert.equal(
		rendered.compose.services.worker.environment.FLUXER_INTERNAL_API_RPC_URLS,
		'http://api:8080/internal/rpc,http://api-b:8080/internal/rpc',
	);
});

test('较小的合法 API 配置不受上游固定1536MiB预算误拒', () => {
	const rendered = renderOdysseia(resolvedFixture(1024), template, {instances: 2, hostMemoryMiB: 6144});
	assert.equal(rendered.budget.apiMemoryTotalMiB, 2048);
	assert.equal(rendered.budget.hostMemoryMiB, 6144);
});

test('渲染拒绝超预算、非整数实例和缺失目标主机预算', () => {
	assert.throws(() => renderOdysseia(resolvedFixture(), template, {instances: 2, hostMemoryMiB: 8192}), /40%/);
	assert.throws(() => renderOdysseia(resolvedFixture(), template, {instances: 1.5, hostMemoryMiB: 16384}), /integer/);
	assert.throws(() => renderOdysseia(resolvedFixture(), template, {instances: 2}), /hostMemoryMiB/);
});
