// SPDX-License-Identifier: AGPL-3.0-or-later

import type {KvQueryMeta, KvTableSpec} from '@app/api/database/CassandraTypes';
import {keyFromColumns, PostgresKvQueryExecutor} from '@app/api/database/PostgresKvQueryExecutor';
import type {IPostgresClient} from '@pkgs/postgres/src/Client';
import {describe, expect, it, vi} from 'vitest';

vi.mock('@app/api/Logger', () => ({Logger: {warn: vi.fn()}}));
type Row = Record<string, unknown>;
const table: KvTableSpec<Row> = {
	name: 'guild_members',
	columns: ['guild_id', 'user_id', 'nick'],
	primaryKey: ['guild_id', 'user_id'],
	partitionKey: ['guild_id', 'user_id'],
};
const tagged = (value: bigint) => ({__fluxer_type: 'bigint', value: value.toString()});
const guildId = 9007199254740993n;
const ids = [1n, 2n, 9n, 10n, 99n, 100n, 9007199254740992n, 9007199254740993n, 9007199254740994n];
const stored = [...ids].reverse().map((id) => ({
	row_key: keyFromColumns(['guild_id', 'user_id'], {guild_id: guildId, user_id: id}),
	row_data: {guild_id: tagged(guildId), user_id: tagged(id), nick: null},
}));
/** 构造受支持的成员分页形状，并允许单独覆盖边界条件 */
function meta(extra: Partial<KvQueryMeta<Row>> = {}): KvQueryMeta<Row> {
	return {action: 'select', table, where: [{kind: 'eq', col: 'guild_id', param: 'g'}], limit: 3, ...extra};
}
/** 记录适配层查询契约；真实排序与 TTL 另由 PostgreSQL 集成测试验证 */
function harness() {
	const statements: Array<{text: string; values?: Array<unknown>}> = [];
	const client = {
		kvTable: () => 'test_kv',
		async query(text: string, values?: Array<unknown>) {
			statements.push({text, values});
			// 此处仅模拟返回行，不能替代真实数据库的排序与过期验证。
			let rows = [...stored];
			if (text.includes('ORDER BY')) {
				rows.sort((a, b) => (BigInt(a.row_data.user_id.value) < BigInt(b.row_data.user_id.value) ? -1 : 1));
				if (text.includes('> $2::numeric'))
					rows = rows.filter((row) => BigInt(row.row_data.user_id.value) > BigInt(String(values![1])));
				rows = rows.slice(0, Number(values!.at(-1)));
			}
			return {rows, rowCount: rows.length};
		},
	} as unknown as IPostgresClient;
	return {executor: new PostgresKvQueryExecutor(client), statements};
}
describe('Postgres KV guild member bounded keyset SELECT', () => {
	it('pushes numeric order and LIMIT, preserving nullable payload and projection', async () => {
		const {executor, statements} = harness();
		const rows = await executor.executeQuery({
			cql: 'probe',
			params: {g: guildId},
			kvMeta: meta({columns: ['user_id', 'nick']}),
		});
		expect(rows).toEqual(ids.slice(0, 3).map((user_id) => ({user_id, nick: null})));
		expect(statements[0]!.values).toEqual([JSON.stringify(tagged(guildId)), 3]);
		expect(statements[0]!.text).toContain("kv.row_data -> 'guild_id' = $1::jsonb");
		expect(statements[0]!.text).toContain('kv.expires_at IS NULL OR kv.expires_at > now()');
		expect(statements[0]!.text).toContain('::numeric END) ASC LIMIT $2');
		expect(statements[0]!.text).not.toContain('> $2::numeric');
	});
	it('allows explicit ascending order and zero limit', async () => {
		const {executor, statements} = harness();
		expect(
			await executor.executeQuery({
				cql: 'probe',
				params: {g: guildId},
				kvMeta: meta({limit: 0, orderBy: {col: 'user_id', direction: 'ASC'}}),
			}),
		).toEqual([]);
		expect(statements[0]!.values!.at(-1)).toBe(0);
	});
	it.each([
		{orderBy: {col: 'user_id', direction: 'DESC'}},
		{orderBy: {col: 'nick', direction: 'ASC'}},
		{unordered: true},
		{limit: undefined},
		{limit: -1},
		{limit: 1.5},
		{where: [...meta().where!, {kind: 'eq', col: 'nick', param: 'nick'}]},
		{where: [...meta().where!, {kind: 'gte', col: 'user_id', param: 'cursor'}]},
		{table: {...table, name: 'other_members'}},
	])('keeps unsupported shape on fallback: %j', async (extra) => {
		const {executor, statements} = harness();
		await executor.executeQuery({
			cql: 'probe',
			params: {g: guildId, nick: null, cursor: 2n},
			kvMeta: meta(extra as Partial<KvQueryMeta<Row>>),
		});
		expect(statements[0]!.text).not.toContain('ORDER BY');
		expect(statements[0]!.text).not.toContain('LIMIT');
	});
	it.each([undefined, null, '9007199254740993', 12])('preserves non-bigint parameter behavior (%s)', async (g) => {
		const {executor, statements} = harness();
		await executor.executeQuery({cql: 'probe', params: {g} as never, kvMeta: meta()});
		expect(statements[0]!.text).not.toContain('ORDER BY');
	});
});
