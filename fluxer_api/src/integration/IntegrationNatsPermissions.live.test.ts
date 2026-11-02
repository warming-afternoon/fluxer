// SPDX-License-Identifier: AGPL-3.0-or-later

import {readFile} from 'node:fs/promises';
import {jetstream} from '@nats-io/jetstream';
import {connect, type NatsConnection} from '@nats-io/transport-node';
import {expect, it} from 'vitest';

it.skipIf(!process.env.INTEGRATION_LIVE_TEST_CONNECTION)(
	'enforces deployed service boundaries and delivers durable content and auth events',
	async () => {
		const metadata = JSON.parse(await readFile(process.env.INTEGRATION_LIVE_TEST_CONNECTION!, 'utf8'));
		if (!metadata.passwords || metadata.isolated_test !== true)
			throw new Error('This test requires an explicitly isolated broker using the deployment roles');
		const servers = `nats://127.0.0.1:${metadata.port}`;
		const connections: Array<NatsConnection> = [];
		/** 连接部署角色，所有凭据仅从临时测试文件读取 */
		async function role(user: string, secret: string, inbox: string) {
			const connection = await connect({servers, user, pass: metadata.passwords[secret], inboxPrefix: inbox});
			connections.push(connection);
			return connection;
		}
		/** 使用实际 JetStream 管理协议验证配置而非复制权限规则 */
		async function request(connection: NatsConnection, subject: string, data: unknown) {
			const response = await connection.request(subject, JSON.stringify(data), {timeout: 1000});
			const parsed = JSON.parse(response.string());
			if (parsed.error) throw new Error(JSON.stringify(parsed.error));
			return parsed;
		}
		try {
			await expect(connect({servers, reconnect: false})).rejects.toThrow();
			await expect(connect({servers, user: 'forum-service', pass: 'incorrect', reconnect: false})).rejects.toThrow();
			const admin = await role('integration-admin', 'ADMIN', '_INBOX.admin');
			const forum = await role('forum-service', 'FORUM', '_INBOX.forum');
			const api = await role('fluxer-api', 'API', '_INBOX.fluxer-api');
			const worker = await role('fluxer-worker', 'WORKER', '_INBOX.fluxer-worker');
			const integration = await role('fluxer-integration', 'SERVICE', '_INBOX.integration');
			const bot = await role('discord-sync', 'BOT', '_INBOX.bot');
			for (const [streamFile, consumerFile, subject, publisher] of [
				['content-stream.json', 'forum-consumer.json', 'events.content.v1.thread.changed', api],
				['auth-stream.json', 'forum-auth-consumer.json', 'events.auth.v1.user_invalidated', worker],
			] as const) {
				const stream = JSON.parse(await readFile(`../deploy/Odysseia-deploy/nats/${streamFile}`, 'utf8'));
				const consumer = JSON.parse(await readFile(`../deploy/Odysseia-deploy/nats/${consumerFile}`, 'utf8'));
				const existing = JSON.parse(
					(await admin.request(`$JS.API.STREAM.INFO.${stream.name}`, '{}', {timeout: 1000})).string(),
				);
				if (existing.error?.code === 404) await request(admin, `$JS.API.STREAM.CREATE.${stream.name}`, stream);
				else if (existing.error) throw new Error(JSON.stringify(existing.error));
				await request(admin, `$JS.API.STREAM.PURGE.${stream.name}`, {});
				if (stream.name === 'ODYSSEIA_AUTH') {
					const observed = await request(forum, `$JS.API.STREAM.INFO.${stream.name}`, {});
					expect(observed.config.name).toBe(stream.name);
				}
				await request(admin, `$JS.API.CONSUMER.DURABLE.CREATE.${stream.name}.${consumer.durable_name}`, {
					stream_name: stream.name,
					config: consumer,
				});
				const info = await request(forum, `$JS.API.CONSUMER.INFO.${stream.name}.${consumer.durable_name}`, {});
				expect(info.config.max_deliver).toBe(-1);
				const event = {event_id: `test_${stream.name}`, user_id: '123', state_version: 1};
				const published = await request(publisher, subject, event);
				expect(published.stream).toBe(stream.name);
				const durable = await jetstream(forum).consumers.get(stream.name, consumer.durable_name);
				const message = await durable.next({expires: 1000});
				expect(message).not.toBeNull();
				expect(message!.json()).toEqual(event);
				expect(message!.seq).toBe(published.seq);
				expect(await message!.ackAck({timeout: 1000})).toBe(true);
				const acknowledged = await request(forum, `$JS.API.CONSUMER.INFO.${stream.name}.${consumer.durable_name}`, {});
				expect(acknowledged.num_ack_pending).toBe(0);
			}
			const identity = integration.subscribe('rpc.identity.v1.ensure_discord', {
				callback: (_error, message) => {
					message?.respond('allowed');
				},
			});
			await integration.flush();
			expect((await bot.request('rpc.identity.v1.ensure_discord', '{}', {timeout: 1000})).string()).toBe('allowed');
			await expect(forum.request('rpc.identity.v1.ensure_discord', '{}', {timeout: 300})).rejects.toThrow();
			await expect(forum.request('$JS.API.STREAM.CREATE.FORBIDDEN', '{}', {timeout: 300})).rejects.toThrow();
			identity.unsubscribe();
		} finally {
			await Promise.all(connections.map((connection) => connection.drain()));
		}
	},
);
