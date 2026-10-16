// SPDX-License-Identifier: AGPL-3.0-or-later

import {createGuildID} from '@app/api/BrandedTypes';
import {
	ensurePostgresKvSchema,
	keyFromColumns,
	PostgresKvQueryExecutor,
} from '@app/api/database/PostgresKvQueryExecutor';
import {GuildFeatures} from '@fluxer/constants/src/GuildConstants';
import {
	getDefaultPostgresClient,
	type IPostgresClient,
	initPostgres,
	shutdownPostgres,
} from '@pkgs/postgres/src/Client';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

const url = process.env.FLUXER_GUILD_AVAILABILITY_TEST_POSTGRES_URL;
const table = `kv_guild_availability_${process.pid}`;
const id = createGuildID(9007199254740995n);
const key = keyFromColumns(['guild_id'], {guild_id: id});
const row = (features: Array<string> = []) =>
	JSON.stringify({
		guild_id: {__fluxer_type: 'bigint', value: id.toString()},
		features: {__fluxer_type: 'set', value: features},
	});

describe.skipIf(!url)('PostgreSQL guild availability invalidation', () => {
	let client: IPostgresClient;
	let first: PostgresKvQueryExecutor;
	let second: PostgresKvQueryExecutor;
	const notices: Array<{table: string; id?: string; clear?: boolean; entity?: string}> = [];
	let monitor: {close(): Promise<void>};
	let firstListenerPid: number;
	beforeAll(async () => {
		await initPostgres({url, kvTable: table, maxConnections: 4});
		client = getDefaultPostgresClient();
		await ensurePostgresKvSchema(client);
		first = new PostgresKvQueryExecutor(client);
		second = new PostgresKvQueryExecutor(client);
		const listenerPids = async () =>
			(
				await client.query<{pid: number}>(
					"SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND application_name = 'fluxer-channel-metadata-listener'",
				)
			).rows.map((row) => row.pid);
		const previousPids = new Set(await listenerPids());
		await first.startChannelMetadataCache(false, true);
		const addedPids = (await listenerPids()).filter((pid) => !previousPids.has(pid));
		// Refuse an ambiguous target rather than terminate another test's listener.
		expect(addedPids).toHaveLength(1);
		firstListenerPid = addedPids[0]!;
		await second.startChannelMetadataCache(true, true);
		monitor = await client.listen!('fluxer_channel_metadata_v1', {
			state: () => {},
			message: (payload) => {
				const notice = JSON.parse(payload);
				if (notice.table === table) notices.push(notice);
			},
		});
	});
	beforeEach(async () => {
		await client.query(`TRUNCATE ${table}`);
		await expect.poll(() => notices.some((notice) => notice.clear)).toBe(true);
		notices.length = 0;
		await client.query(
			`INSERT INTO ${table} (table_name, partition_key, row_key, row_data) VALUES ('guilds', $1, $1, $2)`,
			[key, row()],
		);
		await expect.poll(() => notices.some((notice) => notice.id === id.toString())).toBe(true);
		notices.length = 0;
	});
	afterAll(async () => {
		await monitor?.close();
		await Promise.all([first?.shutdown(), second?.shutdown()]);
		if (client) await client.query(`DROP TABLE IF EXISTS ${table}`);
		await shutdownPostgres();
	});
	const update = async (features: Array<string>) => {
		await client.query(`UPDATE ${table} SET row_data = $1 WHERE table_name = 'guilds'`, [row(features)]);
	};

	it('invalidates both instances across available, staff-only, everyone and restored transitions', async () => {
		for (const executor of [first, second])
			expect((await executor.getGuildAvailability(id))?.unavailableForEveryone).toBe(false);
		for (const [features, everyone, nonStaff] of [
			[[GuildFeatures.UNAVAILABLE_FOR_EVERYONE_BUT_STAFF], false, true],
			[[GuildFeatures.UNAVAILABLE_FOR_EVERYONE], true, false],
			[[], false, false],
		] as Array<[Array<string>, boolean, boolean]>) {
			const invalidations = (executor: PostgresKvQueryExecutor) =>
				Number(executor.renderReadStateMetrics().match(/fluxer_guild_availability_invalidations_total (\d+)/)?.[1]);
			const before = [first, second].map(invalidations);
			await update(features);
			for (const [index, executor] of [first, second].entries()) {
				await expect.poll(() => invalidations(executor)).toBeGreaterThan(before[index]!);
			}
			for (const executor of [first, second]) {
				await expect
					.poll(async () => executor.getGuildAvailability(id))
					.toEqual({guildId: id, unavailableForEveryone: everyone, unavailableForNonStaff: nonStaff});
			}
		}
	});

	it('does not notify for rollback or unrelated writes', async () => {
		await first.getGuildAvailability(id);
		await expect(
			client.transaction(async (db) => {
				await db.query(`UPDATE ${table} SET row_data = $1 WHERE table_name = 'guilds'`, [
					row([GuildFeatures.UNAVAILABLE_FOR_EVERYONE]),
				]);
				throw new Error('rollback');
			}),
		).rejects.toThrow('rollback');
		await client.query(
			`UPDATE ${table} SET row_data = jsonb_set(row_data, '{name}', '"renamed"') WHERE table_name = 'guilds'`,
		);
		await client.query("SELECT pg_notify('fluxer_channel_metadata_v1', $1)", [JSON.stringify({table, id: '0'})]);
		await expect.poll(() => notices.some((notice) => notice.id === '0')).toBe(true);
		expect(notices.filter((notice) => notice.entity === 'guild')).toHaveLength(0);
		expect((await first.getGuildAvailability(id))?.unavailableForEveryone).toBe(false);
	});

	it('handles deletion, recreation, expiration changes and truncation', async () => {
		await first.getGuildAvailability(id);
		await client.query(`DELETE FROM ${table} WHERE table_name = 'guilds'`);
		await expect.poll(async () => first.getGuildAvailability(id)).toBeNull();
		await client.query(
			`INSERT INTO ${table} (table_name, partition_key, row_key, row_data) VALUES ('guilds', $1, $1, $2)`,
			[key, row([GuildFeatures.UNAVAILABLE_FOR_EVERYONE])],
		);
		expect((await first.getGuildAvailability(id))?.unavailableForEveryone).toBe(true);
		await client.query(`UPDATE ${table} SET expires_at = now() - interval '1 second' WHERE table_name = 'guilds'`);
		await expect.poll(async () => first.getGuildAvailability(id)).toBeNull();
		await client.query(`UPDATE ${table} SET expires_at = NULL WHERE table_name = 'guilds'`);
		expect((await first.getGuildAvailability(id))?.unavailableForEveryone).toBe(true);
		await client.query(`TRUNCATE ${table}`);
		await expect.poll(async () => first.getGuildAvailability(id)).toBeNull();
	});

	it('bypasses during a real disconnect and recovers without retaining stale snapshots', async () => {
		await first.getGuildAvailability(id);
		await client.query('SELECT pg_terminate_backend($1)', [firstListenerPid]);
		await expect
			.poll(() => first.renderReadStateMetrics(), {interval: 10})
			.toContain('fluxer_guild_availability_ready 0');
		await update([GuildFeatures.UNAVAILABLE_FOR_EVERYONE]);
		expect((await first.getGuildAvailability(id))?.unavailableForEveryone).toBe(true);
		expect(first.renderReadStateMetrics()).toContain('fluxer_guild_availability_entries 0');
		await expect
			.poll(() => first.renderReadStateMetrics(), {timeout: 6000})
			.toContain('fluxer_guild_availability_ready 1');
		expect((await first.getGuildAvailability(id))?.unavailableForEveryone).toBe(true);
	});

	it('uses the original middleware path when the toggle is disabled', async () => {
		const disabled = new PostgresKvQueryExecutor(client);
		await disabled.startChannelMetadataCache(false, false);
		expect(disabled.getGuildAvailability(id)).toBeNull();
		await disabled.shutdown();
	});
});
