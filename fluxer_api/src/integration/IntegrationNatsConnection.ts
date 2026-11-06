// SPDX-License-Identifier: AGPL-3.0-or-later

import {IntegrationError} from '@app/integration/IntegrationError';
import {connect, type NatsConnection} from '@nats-io/transport-node';

// 在进程内复用连接，连接失败或关闭后允许重建。
let connection: Promise<NatsConnection> | null = null;

/** 使用现有消息代理身份复用进程连接，并拒绝已关闭或正在排空的连接。 */
export async function getIntegrationNatsConnection(): Promise<NatsConnection> {
	if (!process.env.INTEGRATION_NATS_URL || !process.env.INTEGRATION_NATS_USER || !process.env.INTEGRATION_NATS_PASSWORD)
		throw new IntegrationError('UNAVAILABLE', 'Integration broker is unavailable', true);
	connection ??= connect({
		servers: process.env.INTEGRATION_NATS_URL,
		user: process.env.INTEGRATION_NATS_USER,
		pass: process.env.INTEGRATION_NATS_PASSWORD,
		name: 'fluxer-integration-publisher',
		inboxPrefix: process.env.INTEGRATION_EVENT_INBOX_PREFIX || '_INBOX.integration',
		timeout: 3000,
		maxReconnectAttempts: -1,
	}).catch((error: unknown) => {
		connection = null;
		throw error;
	});
	const client = await connection;
	if (client.isClosed() || client.isDraining()) {
		connection = null;
		throw new IntegrationError('UNAVAILABLE', 'Integration broker is unavailable', true);
	}
	return client;
}

/** 清除共享连接引用并关闭现有连接，忽略此前建立连接的失败。 */
export async function shutdownIntegrationNatsConnection(): Promise<void> {
	const pending = connection;
	connection = null;
	if (pending) await (await pending.catch(() => null))?.close();
}
