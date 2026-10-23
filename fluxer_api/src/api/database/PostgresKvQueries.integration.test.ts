// SPDX-License-Identifier: AGPL-3.0-or-later

import {createGuildID, createUserID} from '@app/api/BrandedTypes';
import {setCassandraQueryExecutorForTesting} from '@app/api/database/CassandraQueryExecution';
import {Db} from '@app/api/database/CassandraTypes';
import {
	ensurePostgresKvSchema,
	keyFromColumns,
	PostgresKvQueryExecutor,
} from '@app/api/database/PostgresKvQueryExecutor';
import {GuildMembers, UserGuildSettings} from '@app/api/Tables';
import {dockerAvailable, startPostgresKv, stopPostgresKv} from '@app/api/test/DockerTestContainer';
import {UserSettingsRepository} from '@app/api/user/repositories/UserSettingsRepository';
import {
	getDefaultPostgresClient,
	type IPostgresClient,
	initPostgres,
	shutdownPostgres,
} from '@pkgs/postgres/src/Client';
import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest';

vi.mock('@app/api/Logger', () => ({Logger: {warn: vi.fn(), error: vi.fn()}}));

// 显式 URL 仅供外部创建的隔离测试库使用，默认复用仓库的临时容器工具。
const testUrl = process.env.FLUXER_QUERY_TEST_POSTGRES_URL;
const kvTable = `kv_queries_${process.pid}_${Date.now()}`;
const guildId = createGuildID(9007199254740993n);
const otherGuildId = createGuildID(9007199254740994n);
const firstUserId = 9007199254740993n;
const memberCount = 64;

interface RecordedStatement {
	/** 真实适配层发出的 SQL */
	text: string;

	/** 绑定参数，保持 bigint 的原始编码 */
	values: Array<unknown>;
}

/** 构造与真实 KV 编码一致的 bigint JSON 值 */
function tagged(value: bigint) {
	return {__fluxer_type: 'bigint', value: value.toString()};
}

describe.skipIf(!dockerAvailable && !testUrl)('Postgres KV query correctness integration', () => {
	let raw: IPostgresClient;
	let executor: PostgresKvQueryExecutor;
	let container: string | undefined;
	const statements: Array<RecordedStatement> = [];

	beforeAll(async () => {
		// 单独的表和低连接数保证测试不依赖开发库数据或完整应用栈。
		if (testUrl) {
			await initPostgres({url: testUrl, kvTable, maxConnections: 2});
			raw = getDefaultPostgresClient();
			await ensurePostgresKvSchema(raw);
		} else {
			const started = await startPostgresKv({namePrefix: 'fluxer-query', kvTable, maxConnections: 2});
			raw = started.client;
			container = started.container;
		}
		executor = new PostgresKvQueryExecutor({
			kvTable: () => kvTable,
			async query(text: string, values: Array<unknown> = [], name?: string) {
				statements.push({text, values});
				return raw.query(text, values, name);
			},
		} as IPostgresClient);
		// 通过服务器端造数避免逐条插入；行键使用项目已有的完整主键编码。
		await raw.query(
			`INSERT INTO ${kvTable} (table_name, partition_key, row_key, row_data, expires_at)
SELECT 'guild_members',
       $1 || chr(31) || '{"__fluxer_type":"bigint","value":"' || ($2::numeric + i)::text || '"}',
       $1 || chr(31) || '{"__fluxer_type":"bigint","value":"' || ($2::numeric + i)::text || '"}',
       jsonb_build_object('guild_id', $3::jsonb, 'user_id', jsonb_build_object('__fluxer_type', 'bigint', 'value', ($2::numeric + i)::text), 'nick', NULL, 'padding', repeat('x', 3)),
       CASE WHEN i % 11 = 0 THEN now() - interval '1 hour' ELSE NULL END
FROM generate_series(0, $4::int - 1) AS i`,
			[
				keyFromColumns(['guild_id'], {guild_id: guildId}),
				firstUserId.toString(),
				JSON.stringify(tagged(guildId)),
				memberCount,
			],
		);
		await executor.executeQuery(
			GuildMembers.patchByPk({guild_id: otherGuildId, user_id: createUserID(firstUserId)}, {nick: Db.set(null)}),
		);
	}, 120000);

	afterAll(async () => {
		setCassandraQueryExecutorForTesting(null);
		try {
			if (raw) await raw.query(`DROP TABLE IF EXISTS ${kvTable}`);
		} finally {
			if (container) await stopPostgresKv(container);
			else await shutdownPostgres();
		}
	});

	it('reads complete numeric pages with projection, cross-guild isolation and TTL filtering', async () => {
		const actual: Array<bigint> = [];
		let after: bigint | undefined;
		for (;;) {
			const where =
				after === undefined
					? [GuildMembers.where.eq('guild_id')]
					: [GuildMembers.where.eq('guild_id'), GuildMembers.where.gt('user_id')];
			const rows = await executor.executeQuery<{user_id: bigint; nick: null}>(
				GuildMembers.select({
					columns: ['user_id', 'nick'],
					where,
					limit: 17,
				}).bind(after === undefined ? {guild_id: guildId} : {guild_id: guildId, user_id: after}),
			);
			if (rows.length === 0) break;
			expect(rows.length).toBeLessThanOrEqual(17);
			expect(rows.every((row) => row.nick === null && Object.keys(row).length === 2)).toBe(true);
			actual.push(...rows.map((row) => row.user_id));
			after = rows.at(-1)!.user_id;
		}
		const expected = Array.from({length: memberCount}, (_, index) => index)
			.filter((index) => index % 11 !== 0)
			.map((index) => firstUserId + BigInt(index));
		expect(actual).toEqual(expected);
		expect(new Set(actual).size).toBe(expected.length);
	});

	it('counts exactly the same live members as reference SQL, including empty and other guilds', async () => {
		for (const guild of [guildId, otherGuildId, createGuildID(0n)]) {
			const result = await executor.executeQuery<{count: number}>({
				cql: GuildMembers.selectCountCql({where: GuildMembers.where.eq('guild_id')}),
				params: {guild_id: guild},
			});
			const reference = await raw.query<{count: string}>(
				`SELECT count(*) FROM ${kvTable} WHERE table_name = 'guild_members' AND row_data -> 'guild_id' = $1::jsonb AND (expires_at IS NULL OR expires_at > now())`,
				[JSON.stringify(tagged(guild))],
			);
			expect(result).toEqual([{count: Number(reference.rows[0]!.count)}]);
		}
	});

	it('preserves member TTL boundaries and zero-limit pages in a fixed transaction', async () => {
		const boundaryGuild = createGuildID(9007199254740995n);
		await raw.transaction(async (connection) => {
			const transactionalExecutor = new PostgresKvQueryExecutor({
				kvTable: () => kvTable,
				query: connection.query.bind(connection),
			} as IPostgresClient);
			for (let index = 0; index < 4; index++) {
				await transactionalExecutor.executeQuery(
					GuildMembers.patchByPk(
						{guild_id: boundaryGuild, user_id: createUserID(firstUserId + BigInt(index))},
						{nick: Db.set(null)},
					),
				);
			}
			// 同一事务的 now() 固定，精确验证等于截止时刻的成员也被排除。
			for (const [index, expiry] of [
				[1, "now() - interval '1 hour'"],
				[2, 'now()'],
				[3, "now() + interval '1 hour'"],
			] as const) {
				await connection.query(
					`UPDATE ${kvTable} SET expires_at = ${expiry} WHERE table_name = 'guild_members' AND row_key = $1`,
					[keyFromColumns(['guild_id', 'user_id'], {guild_id: boundaryGuild, user_id: firstUserId + BigInt(index)})],
				);
			}
			const rows = await transactionalExecutor.executeQuery<{user_id: bigint}>(
				GuildMembers.select({
					columns: ['user_id'],
					where: GuildMembers.where.eq('guild_id'),
					limit: 10,
				}).bind({guild_id: boundaryGuild}),
			);
			expect(rows.map((row) => row.user_id)).toEqual([firstUserId, firstUserId + 3n]);
			expect(
				await transactionalExecutor.executeQuery({
					cql: GuildMembers.selectCountCql({where: GuildMembers.where.eq('guild_id')}),
					params: {guild_id: boundaryGuild},
				}),
			).toEqual([{count: 2}]);
			expect(
				await transactionalExecutor.executeQuery(
					GuildMembers.select({
						where: GuildMembers.where.eq('guild_id'),
						limit: 0,
					}).bind({guild_id: boundaryGuild}),
				),
			).toEqual([]);
		});
	});

	it('batches real settings reads and excludes expired, equal-now, missing and other-guild rows', async () => {
		const settings = new UserSettingsRepository();
		// 固定事务内的 now()，使等于当前时刻的 TTL 边界得到确定性验证。
		await raw.transaction(async (connection) => {
			const transactionalExecutor = new PostgresKvQueryExecutor({
				kvTable: () => kvTable,
				async query(text: string, values: Array<unknown> = [], name?: string) {
					statements.push({text, values});
					return connection.query(text, values, name);
				},
			} as IPostgresClient);
			setCassandraQueryExecutorForTesting(transactionalExecutor);
			try {
				for (let index = 0; index < 205; index++) {
					await transactionalExecutor.executeQuery(
						UserGuildSettings.patchByPk(
							{
								user_id: createUserID(firstUserId + BigInt(index)),
								guild_id: index === 203 ? otherGuildId : index === 204 ? createGuildID(0n) : guildId,
							},
							{muted: Db.set(true), version: Db.set(7)},
						),
					);
				}
				for (const [index, expression] of [
					[200, "now() - interval '1 hour'"],
					[201, 'now()'],
					[202, "now() + interval '1 hour'"],
				] as const) {
					await connection.query(
						`UPDATE ${kvTable} SET expires_at = ${expression} WHERE table_name = 'user_guild_settings' AND row_key = $1`,
						[keyFromColumns(['user_id', 'guild_id'], {user_id: firstUserId + BigInt(index), guild_id: guildId})],
					);
				}
				statements.length = 0;
				const ids = [2, 200, 1, 203, 202, 201, 999, 2].map((index) => createUserID(firstUserId + BigInt(index)));
				const result = await settings.findGuildSettingsBatch(ids, guildId);
				expect(result.map((row) => row?.userId ?? null)).toEqual([
					ids[0],
					null,
					ids[2],
					null,
					ids[4],
					null,
					null,
					ids[0],
				]);
				expect(result[0]?.muted).toBe(true);
				expect(result[0]?.version).toBe(7);
				expect(statements).toHaveLength(1);
				expect(
					(await settings.findGuildSettingsBatch([createUserID(firstUserId + 203n)], otherGuildId))[0]?.guildId,
				).toBe(otherGuildId);
				expect((await settings.findGuildSettingsBatch([createUserID(firstUserId + 204n)], null))[0]?.guildId).toBe(0n);
				statements.length = 0;
				const batchIds = Array.from({length: 201}, (_, index) => createUserID(firstUserId + BigInt(index)));
				expect(await settings.findGuildSettingsBatch(batchIds, guildId)).toHaveLength(201);
				expect(statements.map((query) => (query.values[1] as Array<unknown>).length)).toEqual([200, 1]);
				expect(statements.every((query) => query.text.includes('row_key = ANY('))).toBe(true);
			} finally {
				setCassandraQueryExecutorForTesting(null);
			}
		});
	});
});
