// SPDX-License-Identifier: AGPL-3.0-or-later

import {type ChildProcess, execFile, fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {createChannelID, createGuildID} from '@app/api/BrandedTypes';
import {initializeConfig} from '@app/api/Config';
import type {APIConfig} from '@app/api/config/APIConfig';
import {
	executeQuery,
	getChannelMetadata,
	getGuildAvailability,
	renderReadStateMetrics,
	setCassandraQueryExecutorForTesting,
	setDatabaseQueryExecutor,
	shutdownDatabaseQueryExecutor,
	startCassandraMetadataCaches,
} from '@app/api/database/CassandraQueryExecution';
import {Db} from '@app/api/database/CassandraTypes';
import {initializeLogger} from '@app/api/Logger';
import {Channels, Guilds} from '@app/api/Tables';
import {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import {GuildFeatures} from '@fluxer/constants/src/GuildConstants';
import {initCassandra, shutdownCassandra} from '@pkgs/cassandra/src/Client';
import cassandra from 'cassandra-driver';
import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest';

const enabled = process.env.FLUXER_METADATA_INTEGRATION === 'disposable-local';
const container = process.env.FLUXER_METADATA_TEST_VALKEY_CONTAINER;
const keyspace = `fluxer_benchmark_metadata_${process.pid}`;
const channel = createChannelID(991n),
	other = createChannelID(993n),
	guild = createGuildID(992n);
const command = promisify(execFile);

describe.skipIf(!enabled)('real Cassandra + Valkey invalidation across two processes', () => {
	let admin: cassandra.Client;
	let created = false;
	let peer: ChildProcess;
	let requestId = 0;
	const waiting = new Map<
		number,
		{resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>}
	>();

	/** 通过受限 IPC 观察第二个进程的缓存，不暴露运行凭据。 */
	function ask(action: string, entityId?: string): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const id = ++requestId;
			const timer = setTimeout(() => {
				waiting.delete(id);
				reject(new Error('Metadata peer timed out'));
			}, 5000);
			waiting.set(id, {resolve, reject, timer});
			peer.send({id, action, entityId});
		});
	}

	beforeAll(async () => {
		initializeConfig({nodeEnv: 'production'} as APIConfig);
		initializeLogger(new NoopLogger());
		setCassandraQueryExecutorForTesting(null);
		setDatabaseQueryExecutor(null);
		admin = new cassandra.Client({
			contactPoints: ['127.0.0.1'],
			localDataCenter: 'datacenter1',
			protocolOptions: {port: 29042},
		});
		await admin.connect();
		const exists = await admin.execute(
			'SELECT keyspace_name FROM system_schema.keyspaces WHERE keyspace_name=?',
			[keyspace],
			{prepare: true},
		);
		if (exists.rowLength) throw new Error('Refusing a pre-existing test keyspace');
		await admin.execute(
			`CREATE KEYSPACE ${keyspace} WITH replication = {'class':'NetworkTopologyStrategy','datacenter1':1}`,
		);
		created = true;
		await admin.execute(`CREATE TABLE ${keyspace}.guilds (guild_id bigint PRIMARY KEY, features set<text>)`);
		await admin.execute(
			`CREATE TABLE ${keyspace}.channels (channel_id bigint, soft_deleted boolean, guild_id bigint, type int, PRIMARY KEY (channel_id,soft_deleted))`,
		);
		await initCassandra({hosts: ['127.0.0.1'], port: 29042, keyspace, localDc: 'datacenter1'});
		await startCassandraMetadataCaches({channelEnabled: true, guildEnabled: true}, keyspace, {
			namespace: 'metadata-integration',
			kv: {url: 'redis://127.0.0.1:26379'},
		});
		peer = fork(fileURLToPath(new URL('./tests/MetadataCachePeer.ts', import.meta.url)), [keyspace], {
			execArgv: ['--import', import.meta.resolve('tsx')],
			serialization: 'advanced',
			stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
		});
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('Peer startup timed out')), 15000);
			peer.once('exit', () => {
				clearTimeout(timer);
				reject(new Error('Peer exited during startup'));
			});
			peer.on(
				'message',
				(response: {ready?: boolean; startupError?: string; id: number; result: unknown; error?: string}) => {
					if (response.ready) {
						clearTimeout(timer);
						resolve();
						return;
					}
					if (response.startupError) {
						clearTimeout(timer);
						reject(new Error(response.startupError));
						return;
					}
					const pending = waiting.get(response.id);
					if (!pending) return;
					waiting.delete(response.id);
					clearTimeout(pending.timer);
					if (response.error) pending.reject(new Error(response.error));
					else pending.resolve(response.result);
				},
			);
		});
		await vi.waitFor(() => expect(renderReadStateMetrics()).toContain('notifications_subscribed 1'), {timeout: 10000});
		await vi.waitFor(async () => expect(await ask('metrics')).toContain('notifications_subscribed 1'), {
			timeout: 10000,
		});
		await executeQuery('INSERT INTO guilds (guild_id,features) VALUES (:guild_id,:features)', {
			guild_id: guild,
			features: new Set<string>(),
		});
		for (const id of [channel, other])
			await executeQuery(
				'INSERT INTO channels (channel_id,soft_deleted,guild_id,type) VALUES (:channel_id,false,:guild_id,0)',
				{channel_id: id, guild_id: guild},
			);
	}, 120000);

	afterAll(async () => {
		if (container === 'fluxer-cache-integration-valkey') await command('docker', ['start', container]).catch(() => {});
		if (peer?.connected) await ask('shutdown').catch(() => {});
		peer?.kill();
		for (const pending of waiting.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error('Test shutting down'));
		}
		waiting.clear();
		await shutdownDatabaseQueryExecutor();
		await shutdownCassandra();
		if (admin) {
			if (created) await admin.execute(`DROP KEYSPACE ${keyspace}`);
			await admin.shutdown();
		}
	});

	it('invalidates only the changed channel, with fresh data in the second process', async () => {
		await ask('channel', channel.toString());
		await ask('channel', other.toString());
		await ask('guild', guild.toString());
		const before = String(await ask('metrics'));
		await executeQuery(Channels.patchByPk({channel_id: channel, soft_deleted: false}, {type: Db.set(11)}));
		await vi.waitFor(async () => expect(await ask('channel', channel.toString())).toBe(11));
		await ask('channel', other.toString());
		const after = String(await ask('metrics'));
		const misses = (value: string) => Number(value.match(/fluxer_channel_metadata_misses_total (\d+)/)![1]);
		expect(misses(after)).toBe(misses(before) + 1);
		expect((await getChannelMetadata([channel]))!.get(channel)!.type).toBe(11);
	});

	it('invalidates guild availability and deletion and leaves unrelated channel fields warm', async () => {
		await executeQuery(
			Guilds.patchByPk({guild_id: guild}, {features: Db.set(new Set([GuildFeatures.UNAVAILABLE_FOR_EVERYONE]))}),
		);
		await vi.waitFor(async () =>
			expect(await ask('guild', guild.toString())).toMatchObject({unavailableForEveryone: true}),
		);
		await executeQuery(Channels.deleteByPk({channel_id: other, soft_deleted: false}));
		await vi.waitFor(async () => expect(await ask('channel', other.toString())).toBeNull());
		await executeQuery('TRUNCATE channels', {});
		await vi.waitFor(async () => expect(await ask('channel', channel.toString())).toBeNull());
	});

	it.skipIf(container !== 'fluxer-cache-integration-valkey')(
		'keeps database writes available during real Valkey downtime and reconnects',
		async () => {
			await command('docker', ['stop', container!]);
			try {
				await vi.waitFor(() => expect(renderReadStateMetrics()).toContain('notifications_subscribed 0'));
				await expect(
					executeQuery(Guilds.patchByPk({guild_id: guild}, {features: Db.set(new Set<string>())})),
				).resolves.toEqual([]);
				expect((await getGuildAvailability(guild))?.unavailableForEveryone).toBe(false);
				expect(renderReadStateMetrics()).toContain('fluxer_guild_availability_ready 1');
			} finally {
				await command('docker', ['start', container!]);
			}
			await vi.waitFor(async () => expect(await ask('metrics')).toContain('notifications_subscribed 1'), {
				timeout: 10000,
			});
			await executeQuery(
				Guilds.patchByPk({guild_id: guild}, {features: Db.set(new Set([GuildFeatures.UNAVAILABLE_FOR_EVERYONE]))}),
			);
			await vi.waitFor(async () =>
				expect(await ask('guild', guild.toString())).toMatchObject({unavailableForEveryone: true}),
			);
		},
	);
});
