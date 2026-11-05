// SPDX-License-Identifier: AGPL-3.0-or-later

import {Config} from '@app/api/Config';
import {createApiContext} from '@app/api/CreateApiContext';
import {shutdownDatabaseQueryExecutor} from '@app/api/database/CassandraQueryExecution';
import {GatewayRpcClient} from '@app/api/infrastructure/GatewayRpcClient';
import {shutdownStorageChangeFeed} from '@app/api/infrastructure/StorageServiceFactory';
import {JobLedgerRepository} from '@app/api/jobs/JobLedgerRepository';
import {Logger} from '@app/api/Logger';
import {
	closeOwnedKVClient,
	createSnowflakeService,
	setInjectedSnowflakeService,
	setInjectedWorkerService,
	shutdownVoiceResources,
} from '@app/api/middleware/ServiceRegistry';
import {
	getCacheService,
	getInstanceConfigRepository,
	getLimitConfigService,
} from '@app/api/middleware/ServiceSingletons';
import {initializeSearch, shutdownSearch} from '@app/api/SearchFactory';
import {UserGuildNsfwRepository} from '@app/api/user/repositories/UserGuildNsfwRepository';
import {JetStreamWorkerQueue} from '@app/api/worker/JetStreamWorkerQueue';
import {WorkerService} from '@app/api/worker/WorkerService';
import {shutdownIntegrationEvents, startIntegrationEvents} from '@app/integration/IntegrationEvents';
import {IntegrationExchangeRepository} from '@app/integration/IntegrationExchangeRepository';
import {IntegrationHealthServer} from '@app/integration/IntegrationHealthServer';
import {IntegrationIdentityRepository} from '@app/integration/IntegrationIdentityRepository';
import {IntegrationRpcServer} from '@app/integration/IntegrationRpcServer';
import {IntegrationService} from '@app/integration/IntegrationService';
import {connect} from '@nats-io/transport-node';
import {initCassandra, shutdownCassandra} from '@pkgs/cassandra/src/Client';
import {JetStreamConnectionManager} from '@pkgs/nats/src/JetStreamConnectionManager';

/** 启动独立集成进程，仅复用原生依赖而不启动 HTTP 或定时任务 */
export async function startIntegrationMain(): Promise<() => Promise<void>> {
	if (Config.database.backend !== 'cassandra') throw new Error('Integration identity authority requires Cassandra');
	const keyText = process.env.INTEGRATION_EXCHANGE_KEY ?? '';
	if (!/^[a-fA-F0-9]{64}$/.test(keyText)) throw new Error('INTEGRATION_EXCHANGE_KEY must be 64 hex characters');
	const url = process.env.INTEGRATION_NATS_URL;
	if (!url || !process.env.INTEGRATION_NATS_USER || !process.env.INTEGRATION_NATS_PASSWORD)
		throw new Error('Dedicated integration broker credentials are required');
	const cleanups: Array<() => Promise<void> | void> = [];
	let shutdownPromise: Promise<void> | undefined;
	/** 仅清理已登记的资源，并让重复退出请求共享同一次清理 */
	const shutdown = (): Promise<void> =>
		(shutdownPromise ??= (async () => {
			for (const cleanup of cleanups.reverse()) {
				try {
					await cleanup();
				} catch {
					Logger.error('Integration resource cleanup failed');
				}
			}
		})());
	try {
		// 先连接权威存储并验证集成表，再初始化原生业务依赖。
		await initCassandra({
			hosts: Config.cassandra.hosts.split(',').filter(Boolean),
			port: Config.cassandra.port,
			keyspace: Config.cassandra.keyspace,
			localDc: Config.cassandra.localDc,
			username: Config.cassandra.username || undefined,
			password: Config.cassandra.password || undefined,
		});
		cleanups.push(shutdownCassandra, shutdownDatabaseQueryExecutor, closeOwnedKVClient);
		await new IntegrationIdentityRepository().checkHealth();
		await new UserGuildNsfwRepository().checkHealth();
		const snowflake = createSnowflakeService();
		cleanups.push(async () => {
			await snowflake.shutdown();
			setInjectedSnowflakeService(undefined);
		});
		await snowflake.initialize();
		setInjectedSnowflakeService(snowflake);
		const core = new JetStreamConnectionManager({
			url: Config.nats.jetStreamUrl,
			token: Config.nats.authToken || undefined,
			name: 'fluxer-integration-core',
		});
		cleanups.push(async () => {
			await core.drain();
			setInjectedWorkerService(undefined);
		});
		await core.connect();
		setInjectedWorkerService(new WorkerService(new JetStreamWorkerQueue(core), snowflake, new JobLedgerRepository()));
		const instance = getInstanceConfigRepository();
		cleanups.push(() => instance.shutdown());
		await instance.initialize();
		await instance.ensureAccountIdentityMode();
		const limits = getLimitConfigService();
		cleanups.push(() => limits.shutdown(), shutdownVoiceResources, shutdownIntegrationEvents);
		await limits.initialize();
		startIntegrationEvents();
		limits.setAsGlobalInstance();
		cleanups.push(shutdownSearch);
		await initializeSearch(getCacheService());
		const service = new IntegrationService(
			createApiContext(),
			new IntegrationExchangeRepository(Buffer.from(keyText, 'hex')),
		);
		cleanups.push(GatewayRpcClient.shutdown, shutdownStorageChangeFeed);
		// 独立连接外部代理，保持原生内部任务总线和集成 RPC 权限分离。
		const external = await connect({
			servers: url,
			user: process.env.INTEGRATION_NATS_USER,
			pass: process.env.INTEGRATION_NATS_PASSWORD,
			name: 'fluxer-integration',
			maxReconnectAttempts: -1,
			timeout: 5000,
		});
		cleanups.push(() => external.close());
		const rpc = new IntegrationRpcServer(
			external,
			service,
			Number(process.env.INTEGRATION_MAX_INFLIGHT ?? 32),
			(process.env.INTEGRATION_ALLOWED_REPLY_PREFIXES ?? '_INBOX.forum.,_INBOX.bot.').split(','),
			process.env.INTEGRATION_FORUM_REPLY_PREFIX ?? '_INBOX.forum.',
		);
		cleanups.push(() => rpc.stop());
		await rpc.start();
		const health = new IntegrationHealthServer(async () => {
			if (!rpc.isReady() || external.isClosed() || external.isDraining())
				throw new Error('Integration broker unavailable');
			await Promise.all([
				external.flush(),
				core.getConnection().flush(),
				service.dispatch('rpc.integration.v1.service_info', {version: 1, request_id: 'healthcheck_internal'}),
			]);
		});
		cleanups.push(() => health.stop());
		await health.start(Number(process.env.INTEGRATION_HEALTH_PORT ?? 8091));
		Logger.info('Fluxer integration is ready');
		return shutdown;
	} catch (error) {
		await shutdown();
		throw error;
	}
}
