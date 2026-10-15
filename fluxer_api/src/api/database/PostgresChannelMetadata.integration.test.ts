// SPDX-License-Identifier: AGPL-3.0-or-later

import {createChannelID, createGuildID} from '@app/api/BrandedTypes';
import {ChannelMetadataCache} from '@app/api/database/ChannelMetadataCache';
import {PostgresChannelMetadataInvalidation} from '@app/api/database/PostgresChannelMetadataInvalidation';
import {
	ensurePostgresKvSchema,
	keyFromColumns,
	PostgresKvQueryExecutor,
} from '@app/api/database/PostgresKvQueryExecutor';
import {
	getDefaultPostgresClient,
	type IPostgresClient,
	initPostgres,
	shutdownPostgres,
} from '@pkgs/postgres/src/Client';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

const testUrl = process.env.FLUXER_CHANNEL_METADATA_TEST_POSTGRES_URL;
const kvTable = `kv_channel_meta_${process.pid}`;
const id = createChannelID(9007199254740995n);
const key = keyFromColumns(['channel_id', 'soft_deleted'], {channel_id: id, soft_deleted: false});

/** 构造与实际 KV 编码一致的元数据，直接 SQL 写入用于验证绕过仓库的失效 */
function encodedRow(type = 1): string {
	return JSON.stringify({
		channel_id: {__fluxer_type: 'bigint', value: id.toString()},
		guild_id: {__fluxer_type: 'bigint', value: '9'},
		type,
		soft_deleted: false,
	});
}

describe.skipIf(!testUrl)('PostgreSQL channel metadata invalidation integration', () => {
	let client: IPostgresClient;
	let first: PostgresKvQueryExecutor;
	let second: PostgresKvQueryExecutor;
	let ready = false;
	let monitor: {close(): Promise<void>};
	let expectedInvalidations = 0;
	const notices: Array<{table: string; id?: string; clear?: boolean}> = [];

	beforeAll(async () => {
		await initPostgres({url: testUrl, kvTable, maxConnections: 4});
		client = getDefaultPostgresClient();
		await ensurePostgresKvSchema(client);
		first = new PostgresKvQueryExecutor(client);
		second = new PostgresKvQueryExecutor(client);
		await first.startChannelMetadataCache();
		await second.startChannelMetadataCache();
		monitor = await client.listen!('fluxer_channel_metadata_v1', {
			state: (state) => {
				ready = state;
			},
			message: (payload) => {
				const event = JSON.parse(payload);
				if (event.table === kvTable) {
					notices.push(event);
					if (!event.clear) expectedInvalidations += 1;
				}
			},
		});
		expect(first.renderReadStateMetrics()).toContain('fluxer_channel_metadata_ready 1');
	});
	beforeEach(async () => {
		notices.length = 0;
		await client.query(`TRUNCATE ${kvTable}`);
		await expect.poll(() => notices.some((notice) => notice.clear)).toBe(true);
		notices.length = 0;
		await client.query(
			`INSERT INTO ${kvTable} (table_name, partition_key, row_key, row_data) VALUES ('channels', $1, $1, $2)`,
			[key, encodedRow()],
		);
		await expect.poll(() => notices.length).toBeGreaterThan(0);
		notices.length = 0;
		await expect
			.poll(() => first.renderReadStateMetrics())
			.toContain(`fluxer_channel_metadata_invalidations_total ${expectedInvalidations}\n`);
		await expect
			.poll(() => second.renderReadStateMetrics())
			.toContain(`fluxer_channel_metadata_invalidations_total ${expectedInvalidations}\n`);
	});
	afterAll(async () => {
		await monitor?.close();
		await Promise.all([first?.shutdown(), second?.shutdown()]);
		if (client) await client.query(`DROP TABLE IF EXISTS ${kvTable}`);
		await shutdownPostgres();
	});

	it('shares single and bulk lookups and invalidates two process-shaped caches after raw SQL commits', async () => {
		expect((await first.getChannelMetadata([id])).get(id)?.type).toBe(1);
		expect((await second.getChannelMetadata([id])).get(id)?.guildId).toBe(createGuildID(9n));
		await first.getChannelMetadata([id]);
		expect(first.renderReadStateMetrics()).toContain('fluxer_channel_metadata_hits_total 1');
		await client.query(
			`UPDATE ${kvTable} SET row_data = jsonb_set(row_data, '{type}', '2') WHERE table_name = 'channels'`,
		);
		await expect.poll(async () => (await first.getChannelMetadata([id])).get(id)?.type).toBe(2);
		await expect.poll(async () => (await second.getChannelMetadata([id])).get(id)?.type).toBe(2);
		await client.query(
			`UPDATE ${kvTable} SET row_data = jsonb_set(row_data, '{guild_id,value}', '"10"') WHERE table_name = 'channels'`,
		);
		await expect.poll(async () => (await first.getChannelMetadata([id])).get(id)?.guildId).toBe(createGuildID(10n));
	});

	it('does not publish on rollback or high frequency unrelated field updates', async () => {
		await first.getChannelMetadata([id]);
		await expect(
			client.transaction(async (db) => {
				await db.query(
					`UPDATE ${kvTable} SET row_data = jsonb_set(row_data, '{type}', '99') WHERE table_name = 'channels'`,
				);
				throw new Error('rollback');
			}),
		).rejects.toThrow('rollback');
		await client.query(
			`UPDATE ${kvTable} SET row_data = jsonb_set(row_data, '{last_message_id}', '123'), updated_at = now() WHERE table_name = 'channels'`,
		);
		// 同一数据库的额外通知作为屏障，确保更早提交的通知已经送达。
		await client.query("SELECT pg_notify('fluxer_channel_metadata_v1', $1)", [
			JSON.stringify({table: kvTable, id: '0'}),
		]);
		await expect.poll(() => notices.some((notice) => notice.id === '0')).toBe(true);
		expect(notices.filter((notice) => notice.id === id.toString())).toHaveLength(0);
		expect((await first.getChannelMetadata([id])).get(id)?.type).toBe(1);
	});

	it('invalidates soft deletion, physical deletion, recreation and truncation', async () => {
		await first.getChannelMetadata([id]);
		await client.query(
			`UPDATE ${kvTable} SET row_data = jsonb_set(row_data, '{soft_deleted}', 'true') WHERE table_name = 'channels'`,
		);
		await expect.poll(async () => (await first.getChannelMetadata([id])).size).toBe(0);
		await client.query(`DELETE FROM ${kvTable} WHERE table_name = 'channels'`);
		await client.query(
			`INSERT INTO ${kvTable} (table_name, partition_key, row_key, row_data) VALUES ('channels', $1, $1, $2)`,
			[key, encodedRow(3)],
		);
		await expect.poll(async () => (await first.getChannelMetadata([id])).get(id)?.type).toBe(3);
		await client.query(`TRUNCATE ${kvTable}`);
		await expect.poll(async () => (await first.getChannelMetadata([id])).size).toBe(0);
	});

	it('isolates custom KV namespaces and bypasses during a real listener reconnect', async () => {
		await first.getChannelMetadata([id]);
		await client.query("SELECT pg_notify('fluxer_channel_metadata_v1', $1)", [
			JSON.stringify({table: `${kvTable}_other`, clear: true}),
		]);
		await client.query("SELECT pg_notify('fluxer_channel_metadata_v1', $1)", [
			JSON.stringify({table: kvTable, id: '0'}),
		]);
		await expect.poll(() => notices.some((notice) => notice.id === '0')).toBe(true);
		expect(first.renderReadStateMetrics()).toContain('fluxer_channel_metadata_entries 1');
		await client.query(
			"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'fluxer-channel-metadata-listener' AND pid <> pg_backend_pid()",
		);
		await expect.poll(() => ready, {interval: 10}).toBe(false);
		expect(first.renderReadStateMetrics()).toContain('fluxer_channel_metadata_ready 0');
		await client.query(
			`UPDATE ${kvTable} SET row_data = jsonb_set(row_data, '{type}', '4') WHERE table_name = 'channels'`,
		);
		expect((await first.getChannelMetadata([id])).get(id)?.type).toBe(4);
		expect(first.renderReadStateMetrics()).toContain('fluxer_channel_metadata_entries 0');
		await expect.poll(() => ready, {timeout: 6000}).toBe(true);
		await expect.poll(() => first.renderReadStateMetrics()).toContain('fluxer_channel_metadata_ready 1');
		expect((await first.getChannelMetadata([id])).get(id)?.type).toBe(4);
	});

	it('stays uncached when notification capability or trigger installation is unavailable', async () => {
		const cache = new ChannelMetadataCache(async () => new Map());
		const unavailable = new PostgresChannelMetadataInvalidation({kvTable: () => kvTable} as IPostgresClient, cache);
		await unavailable.start();
		expect(cache.renderMetrics()).toContain('fluxer_channel_metadata_ready 0');
		const broken = new PostgresKvQueryExecutor({
			...client,
			kvTable: () => kvTable,
			listen: client.listen!.bind(client),
			transaction: async () => {
				throw new Error('DDL denied');
			},
		} as IPostgresClient);
		await broken.startChannelMetadataCache();
		expect(broken.renderReadStateMetrics()).toContain('fluxer_channel_metadata_ready 0');
		await broken.shutdown();
	});
});
