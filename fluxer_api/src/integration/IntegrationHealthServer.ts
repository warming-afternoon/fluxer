// SPDX-License-Identifier: AGPL-3.0-or-later

import {createServer, type Server} from 'node:http';

/** 提供轻量存活与真实依赖就绪检查 */
export class IntegrationHealthServer {
	/** 当前健康检查 HTTP 服务实例 */
	private server: Server | null = null;

	/** 关闭开始后立即停止报告可用 */
	private stopping = false;

	/** 注入真实依赖探测，避免健康端点重新启动原生 API */
	constructor(private readonly probe: () => Promise<void>) {}

	/** 仅提供容器健康探测端点 */
	async start(port: number): Promise<void> {
		if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid INTEGRATION_HEALTH_PORT');
		const server = createServer((request, response) => {
			if (request.method !== 'GET' || !['/_ready', '/_live'].includes(request.url ?? '')) {
				response.writeHead(404).end();
				return;
			}
			if (this.stopping) {
				response.writeHead(503).end();
				return;
			}
			if (request.url === '/_live') {
				response.writeHead(204).end();
				return;
			}
			// 限制依赖探测耗时；退出期间即使探测成功也不能报告就绪。
			let timer: ReturnType<typeof setTimeout> | undefined;
			const deadline = new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error('Readiness timeout')), 1500);
			});
			void Promise.race([this.probe(), deadline])
				.then(
					() => response.writeHead(this.stopping ? 503 : 204).end(),
					() => response.writeHead(503).end(),
				)
				.finally(() => clearTimeout(timer));
		});
		this.server = server;
		server.requestTimeout = 3000;
		server.headersTimeout = 3000;
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(port, '0.0.0.0', resolve);
		});
	}

	/** 停止健康响应并关闭已有空闲连接 */
	async stop(): Promise<void> {
		this.stopping = true;
		const server = this.server;
		this.server = null;
		if (!server) return;
		server.closeAllConnections();
		await new Promise<void>((resolve) => {
			server.close(() => resolve());
		});
	}
}
