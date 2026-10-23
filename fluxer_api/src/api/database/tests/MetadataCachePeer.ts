// SPDX-License-Identifier: AGPL-3.0-or-later

import {createChannelID, createGuildID} from '@app/api/BrandedTypes';
import {initializeConfig} from '@app/api/Config';
import type {APIConfig} from '@app/api/config/APIConfig';
import {
	getChannelMetadata,
	getGuildAvailability,
	renderReadStateMetrics,
	shutdownDatabaseQueryExecutor,
	startCassandraMetadataCaches,
} from '@app/api/database/CassandraQueryExecution';
import {initializeLogger} from '@app/api/Logger';
import {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import {initCassandra, shutdownCassandra} from '@pkgs/cassandra/src/Client';

/** 在独立进程内验证真实数据库与广播，所有标识由隔离测试父进程提供。 */
async function main(): Promise<void> {
	const keyspace = process.argv[2]!;
	if (!/^fluxer_benchmark_metadata_\d+$/.test(keyspace)) throw new Error('Disposable test keyspace required');
	initializeConfig({nodeEnv: 'production'} as APIConfig);
	initializeLogger(new NoopLogger());
	await initCassandra({hosts: ['127.0.0.1'], port: 29042, keyspace, localDc: 'datacenter1'});
	await startCassandraMetadataCaches({channelEnabled: true, guildEnabled: true}, keyspace, {
		namespace: 'metadata-integration',
		kv: {url: 'redis://127.0.0.1:26379'},
	});
	process.on('message', async (request: {id: number; action: string; entityId?: string}) => {
		try {
			let result: unknown;
			if (request.action === 'channel') {
				const id = createChannelID(BigInt(request.entityId!));
				result = (await getChannelMetadata([id]))?.get(id)?.type ?? null;
			} else if (request.action === 'guild')
				result = await getGuildAvailability(createGuildID(BigInt(request.entityId!)));
			else if (request.action === 'metrics') result = renderReadStateMetrics();
			else if (request.action === 'shutdown') {
				await shutdownDatabaseQueryExecutor();
				await shutdownCassandra();
				process.send?.({id: request.id, result: true});
				process.disconnect?.();
				return;
			} else throw new Error('Unknown test action');
			// 社区快照含 bigint，通过高级 IPC 序列化传输，不写入日志。
			process.send?.({id: request.id, result});
		} catch (error) {
			process.send?.({id: request.id, error: error instanceof Error ? error.name : 'UnknownError'});
		}
	});
	process.send?.({ready: true});
}

void main().catch((error) => {
	process.send?.({startupError: error instanceof Error ? error.name : 'UnknownError'});
	process.exitCode = 1;
	process.disconnect?.();
});
