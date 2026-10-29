// SPDX-License-Identifier: AGPL-3.0-or-later
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';

const require = createRequire(new URL('../../fluxer_api/package.json', import.meta.url));
const {connect} = require('@nats-io/transport-node');
const {jetstreamManager} = require('@nats-io/jetstream');

// 仅使用独立管理账号预建流及消费者，业务账号没有创建或删除流的权限。
if (!process.env.INTEGRATION_NATS_URL || !process.env.INTEGRATION_ADMIN_PASSWORD) {
	throw Error('Set INTEGRATION_NATS_URL and INTEGRATION_ADMIN_PASSWORD');
}
const nc = await connect({
	servers: process.env.INTEGRATION_NATS_URL,
	user: 'integration-admin',
	pass: process.env.INTEGRATION_ADMIN_PASSWORD,
	inboxPrefix: '_INBOX.admin',
	timeout: 5000,
});
try {
	const manager = await jetstreamManager(nc, {checkAPI: false});
	const stream = JSON.parse(await fs.readFile(new URL('./nats/content-stream.json', import.meta.url), 'utf8'));
	const consumer = JSON.parse(await fs.readFile(new URL('./nats/forum-consumer.json', import.meta.url), 'utf8'));
	await manager.streams.add(stream);
	await manager.consumers.add(stream.name, consumer);
	console.log('ODYSSEIA_CONTENT / forum-index ready; no content producer or consumer has been started.');
} finally {
	await nc.drain();
}
