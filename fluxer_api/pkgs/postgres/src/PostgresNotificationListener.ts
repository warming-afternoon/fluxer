// SPDX-License-Identifier: AGPL-3.0-or-later

import pg, {type ClientConfig} from 'pg';

export interface PostgresNotificationCallbacks {
	/** 收到数据库已提交的变更通知 */
	message: (payload: string) => void;

	/** 完成订阅或失去连接时立即切换缓存可用性 */
	state: (ready: boolean) => void;
}

/** 在查询连接池之外维持一条可重连的通知连接 */
export class PostgresNotificationListener {
	private client: pg.Client | null = null;
	private connecting: Promise<void> | null = null;
	private retry: ReturnType<typeof setTimeout> | null = null;
	private stopped = false;
	private delayMs = 500;

	/** 复用数据库认证及 TLS 配置，不共享连接池中的连接 */
	constructor(
		private readonly config: ClientConfig,
		private readonly channel: string,
		private readonly callbacks: PostgresNotificationCallbacks,
	) {}

	/** 初次订阅失败时交由调用方关闭缓存，重连失败则继续有限退避 */
	async start(): Promise<void> {
		this.connecting = this.open();
		try {
			await this.connecting;
		} finally {
			this.connecting = null;
		}
	}

	/** 先安装事件处理再订阅，只有 LISTEN 确认后才允许填充缓存 */
	private async open(): Promise<void> {
		const client = new pg.Client({
			...this.config,
			application_name: 'fluxer-channel-metadata-listener',
			connectionTimeoutMillis: 5000,
			query_timeout: 5000,
			keepAlive: true,
			keepAliveInitialDelayMillis: 10_000,
		});
		this.client = client;
		client.on('notification', (notice) => {
			if (this.client === client && notice.channel === this.channel) this.callbacks.message(notice.payload ?? '');
		});
		client.on('error', () => this.disconnected(client));
		client.on('end', () => this.disconnected(client));
		try {
			await client.connect();
			await client.query(`LISTEN "${this.channel}"`);
			if (!this.stopped && this.client === client) {
				this.delayMs = 500;
				this.callbacks.state(true);
			}
		} catch (error) {
			this.disconnected(client);
			await client.end().catch(() => undefined);
			throw error;
		}
	}

	/** 断线立即停用缓存，定时器只保留一个且不会阻止进程退出 */
	private disconnected(client: pg.Client): void {
		if (this.client !== client) return;
		this.client = null;
		this.callbacks.state(false);
		void client.end().catch(() => undefined);
		if (this.stopped || this.retry) return;
		this.retry = setTimeout(() => {
			this.retry = null;
			if (this.stopped) return;
			void this.start().catch(() => undefined);
		}, this.delayMs);
		this.retry.unref();
		this.delayMs = Math.min(this.delayMs * 2, 5000);
	}

	/** 停止重连并关闭专用连接，停机后不再允许恢复缓存 */
	async close(): Promise<void> {
		this.stopped = true;
		if (this.retry) clearTimeout(this.retry);
		this.retry = null;
		this.callbacks.state(false);
		const client = this.client;
		this.client = null;
		await client?.end().catch(() => undefined);
		await this.connecting?.catch(() => undefined);
	}
}
