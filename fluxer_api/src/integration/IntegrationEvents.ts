// SPDX-License-Identifier: AGPL-3.0-or-later

import {randomUUID} from 'node:crypto';
import {Logger} from '@app/api/Logger';
import {connect, type NatsConnection} from '@nats-io/transport-node';

let connection: Promise<NatsConnection> | null = null;
let stopped = false;

/** 使用每进程独立凭据连接外部总线，原生服务仅需事件发布权限 */
export async function publishIntegrationEvent(subject: string, data: Record<string, string | number>): Promise<void> {
	if (!process.env.INTEGRATION_NATS_URL || stopped) return;
	try {
		connection ??= connect({
			servers: process.env.INTEGRATION_NATS_URL,
			user: process.env.INTEGRATION_NATS_USER,
			pass: process.env.INTEGRATION_NATS_PASSWORD,
			name: 'fluxer-invalidation-publisher',
			timeout: 3000,
			maxReconnectAttempts: -1,
		}).catch((error: unknown) => {
			connection = null;
			throw error;
		});
		const client = await connection;
		client.publish(subject, JSON.stringify({event_id: randomUUID(), occurred_at: new Date().toISOString(), ...data}));
		await client.flush();
	} catch {
		// 新RPC解析读取权威存储；若仅发布者失连，Forum既有缓存可能保持到原TTL，不能保证立即失效。
		Logger.warn({subject}, 'Integration invalidation publish failed');
	}
}

/** 关闭已初始化的发布连接 */
export async function shutdownIntegrationEvents(): Promise<void> {
	stopped = true;
	const pending = connection;
	connection = null;
	if (pending) {
		const client = await pending.catch(() => null);
		await client?.drain();
	}
}
