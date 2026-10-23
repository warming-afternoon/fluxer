// SPDX-License-Identifier: AGPL-3.0-or-later

import {createGuildID, createUserID} from '@app/api/BrandedTypes';
import {setCassandraQueryExecutorForTesting} from '@app/api/database/CassandraQueryExecution';
import {Db} from '@app/api/database/CassandraTypes';
import {
	ensurePostgresKvSchema,
	keyFromColumns,
	PostgresKvQueryExecutor,
} from '@app/api/database/PostgresKvQueryExecutor';
import {GuildMembers} from '@app/api/Tables';
import {dockerAvailable, startPostgresKv, stopPostgresKv} from '@app/api/test/DockerTestContainer';
import {
	getDefaultPostgresClient,
	type IPostgresClient,
	initPostgres,
	shutdownPostgres,
} from '@pkgs/postgres/src/Client';
import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest';

vi.mock('@app/api/Logger', () => ({Logger: {warn: vi.fn(), error: vi.fn()}}));

// 显式 URL 仅供外部创建的隔离测试库使用，默认复用仓库的临时容器工具。
const testUrl = process.env.FLUXER_PERFORMANCE_TEST_POSTGRES_URL;
const kvTable = `kv_perf_${process.pid}_${Date.now()}`;
const guildId = createGuildID(9007199254740993n);
const otherGuildId = createGuildID(9007199254740994n);
const firstUserId = 9007199254740993n;
const memberCount = 20_000;

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

describe.skipIf(!dockerAvailable && !testUrl)('Postgres KV performance integration', () => {
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
			const started = await startPostgresKv({namePrefix: 'fluxer-perf', kvTable, maxConnections: 2});
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
       jsonb_build_object('guild_id', $3::jsonb, 'user_id', jsonb_build_object('__fluxer_type', 'bigint', 'value', ($2::numeric + i)::text), 'nick', NULL, 'padding', repeat('x', 300)),
       CASE WHEN i % 1000 = 0 THEN now() - interval '1 hour' ELSE NULL END
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

	it('creates both indexes idempotently and uses them in custom and generic plans', async () => {
		await ensurePostgresKvSchema(raw);
		await ensurePostgresKvSchema(raw);
		const indexes = await raw.query<{indexname: string}>('SELECT indexname FROM pg_indexes WHERE tablename = $1', [
			kvTable,
		]);
		expect(indexes.rows.map((row) => row.indexname)).toEqual(
			expect.arrayContaining([`${kvTable}_guild_members_user_numeric_idx`, `${kvTable}_guild_members_count_cover_idx`]),
		);
		// 清理可见性映射后观察自然计划，不关闭顺序扫描或强制使用索引。
		await raw.query(`VACUUM ANALYZE ${kvTable}`);
		statements.length = 0;
		await executor.executeQuery(
			GuildMembers.select({
				columns: ['user_id'],
				where: [GuildMembers.where.eq('guild_id'), GuildMembers.where.gt('user_id')],
				limit: 1001,
			}).bind({guild_id: guildId, user_id: firstUserId + 10_000n}),
		);
		await executor.executeQuery({
			cql: GuildMembers.selectCountCql({where: GuildMembers.where.eq('guild_id')}),
			params: {guild_id: guildId},
		});
		const queries = [...statements];
		await raw.transaction(async (connection) => {
			for (const mode of ['force_custom_plan', 'force_generic_plan']) {
				await connection.query(`SET LOCAL plan_cache_mode = ${mode}`);
				for (const [index, query] of queries.entries()) {
					const name = `perf_plan_${index}`;
					await connection.query(`PREPARE ${name} AS ${query.text}`);
					// EXECUTE 不接受外部绑定参数，使用 quote_literal 在服务器端安全生成常量。
					const literals = await connection.query<{value: string}>(
						'SELECT quote_literal(value) AS value FROM unnest($1::text[]) WITH ORDINALITY AS entry(value, ordinal) ORDER BY ordinal',
						[query.values.map(String)],
					);
					const result = await connection.query(
						`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) EXECUTE ${name}(${literals.rows.map((row) => row.value).join(',')})`,
					);
					const plan = result.rows[0]!['QUERY PLAN'];
					const serialized = JSON.stringify(plan);
					expect(serialized).toContain(
						index === 0 ? `${kvTable}_guild_members_user_numeric_idx` : `${kvTable}_guild_members_count_cover_idx`,
					);
					console.info(
						JSON.stringify({kind: 'postgres-performance-plan', mode, query: index === 0 ? 'page' : 'count', plan}),
					);
					await connection.query(`DEALLOCATE ${name}`);
				}
			}
		});
	});

});
