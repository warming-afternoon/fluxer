// SPDX-License-Identifier: AGPL-3.0-or-later

import {createServer, type Server} from 'node:http';

export class IntegrationHealthServer {
	private server: Server | null = null;
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
