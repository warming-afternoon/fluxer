// SPDX-License-Identifier: AGPL-3.0-or-later
// Offline Compose resolution only: no images built, containers started or real secrets read.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const switches = [
	'FLUXER_COMBINED_CHANNEL_AUTH_ENABLED',
	'FLUXER_COMBINED_RATE_LIMIT_ENABLED',
	'FLUXER_GATEWAY_CLEAR_BATCH_ENABLED',
	'FLUXER_PUSH_CLEAR_BATCH_ENABLED',
];
const required = [
	...fs.readFileSync(path.join(here, 'docker-compose.yml'), 'utf8').matchAll(/\$\{([A-Z0-9_]+):\?/g),
].map((x) => x[1]);
/** 仅解析带模拟配置的部署覆盖，不读取真实密钥或启动容器。 */
function config({compat = false, disabled = false, missingTag = false, legacyTag = false} = {}) {
	const env = {...process.env};
	for (const key of switches) delete env[key];
	delete env.FLUXER_BCD_IMAGE_TAG;
	for (const key of required) env[key] = 'test-only-not-a-real-secret';
	Object.assign(env, {
		FLUXER_DOMAIN: 'example.test',
		FLUXER_IMAGE_TAG: 'unchanged-service-test',
		FLUXER_SOURCE_SHA: '0123456789abcdef0123456789abcdef01234567',
		FLUXER_PRODUCT_BUILD_TAG: 'request-push-test',
	});
	if (disabled) for (const key of switches) env[key] = 'false';
	if (legacyTag) {
		env.FLUXER_BCD_IMAGE_TAG = env.FLUXER_PRODUCT_BUILD_TAG;
		delete env.FLUXER_PRODUCT_BUILD_TAG;
	}
	if (missingTag) delete env.FLUXER_PRODUCT_BUILD_TAG;
	const args = [
		'compose',
		'--env-file',
		'/dev/null',
		'-f',
		path.join(here, 'docker-compose.yml'),
		'-f',
		path.join(here, 'request-and-push-optimizations.compose.yml'),
	];
	if (compat) args.push('-f', path.join(here, 'request-and-push-compat.compose.yml'));
	args.push('config', '--format', 'json');
	return JSON.parse(execFileSync('docker', args, {env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}));
}
test('normal source-build deployment enables combined authorization, rate limits and clear transport with shared API image', () => {
	const c = config();
	for (const role of ['api', 'worker'])
		for (const key of switches.slice(0, 2)) assert.equal(c.services[role].environment[key], 'true');
	assert.equal(c.services.gateway.environment.FLUXER_GATEWAY_CLEAR_BATCH_ENABLED, 'true');
	assert.equal(c.services.push.environment.FLUXER_PUSH_CLEAR_BATCH_ENABLED, 'true');
	assert.equal(c.services.worker.image, c.services.api.image);
	assert.equal(c.services.api.build.context, path.resolve(here, '../..'));
	assert.equal(c.services.gateway.build.dockerfile, 'fluxer_gateway/Dockerfile');
	assert.equal(c.services.push.build.dockerfile, 'fluxer_push/Dockerfile');
	assert.match(c.services.api.image, /:request-push-test$/);
	assert.match(c.services.messages.image, /:unchanged-service-test$/);
});
test('existing explicit false configuration remains false', () => {
	const c = config({disabled: true});
	for (const key of switches.slice(0, 2)) assert.equal(c.services.api.environment[key], 'false');
	assert.equal(c.services.gateway.environment.FLUXER_GATEWAY_CLEAR_BATCH_ENABLED, 'false');
	assert.equal(c.services.push.environment.FLUXER_PUSH_CLEAR_BATCH_ENABLED, 'false');
});
test('transition overlay disables clear senders and combined API operations while keeping all new receivers capable', () => {
	const c = config({compat: true});
	for (const role of ['api', 'worker'])
		for (const key of switches.slice(0, 2)) assert.equal(c.services[role].environment[key], 'false');
	assert.equal(c.services.gateway.environment.FLUXER_GATEWAY_CLEAR_BATCH_ENABLED, 'false');
	assert.equal(c.services.push.environment.FLUXER_PUSH_CLEAR_BATCH_ENABLED, 'true');
});
test('source-build overlay refuses an unspecified release tag', () => assert.throws(() => config({missingTag: true})));

test('legacy image tag remains an alias without changing service configuration', () => {
	const c = config({legacyTag: true});
	assert.equal(c.services.api.image, config().services.api.image);
	assert.equal(c.services.gateway.image, config().services.gateway.image);
	assert.equal(c.services.push.image, config().services.push.image);
});
