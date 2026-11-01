// SPDX-License-Identifier: AGPL-3.0-or-later

import type {KvQueryMeta, KvTableSpec} from '@app/api/database/CassandraTypes';
import {PostgresKvQueryExecutor} from '@app/api/database/PostgresKvQueryExecutor';
import type {IPostgresClient} from '@pkgs/postgres/src/Client';
import {describe, expect, it, vi} from 'vitest';

vi.mock('@app/api/Logger', () => ({Logger: {warn: vi.fn()}}));
const table: KvTableSpec<Record<string, unknown>> = {
	name: 'guild_members',
	columns: ['guild_id', 'user_id'],
	primaryKey: ['guild_id', 'user_id'],
	partitionKey: ['guild_id', 'user_id'],
};
describe('guild member exact count covering-index SQL', () => {
	it('retains bounds, bindings and TTL with an independent prepared statement name', async () => {
		const statements: Array<{text: string; values?: Array<unknown>; name?: string}> = [];
		const client = {
			kvTable: () => 'probe',
			async query(text: string, values?: Array<unknown>, name?: string) {
				statements.push({text, values, name});
				return {rows: [{count: '400000'}], rowCount: 1};
			},
		} as unknown as IPostgresClient;
		const executor = new PostgresKvQueryExecutor(client);
		const meta: KvQueryMeta = {action: 'count', table, where: [{kind: 'eq', col: 'guild_id', param: 'guild'}]};
		const query = {cql: 'probe', kvMeta: meta, params: {guild: 9007199254740993n}};
		expect(await executor.executeQuery(query)).toEqual([{count: 400000}]);
		await executor.executeQuery({...query, kvMeta: {...meta, table: {...table, name: 'other_table'}}});
		expect(statements[0]!.name).toBe('kv_count_guild_members_range');
		expect(statements[1]!.name).toBe('kv_count_range');
		expect(statements[0]!.text.replace(" AND kv.table_name = 'guild_members'", '')).toBe(statements[1]!.text);
		expect(statements[0]!.text).toContain('kv.table_name = $1');
		expect(statements[0]!.text).toContain('(kv.expires_at IS NULL OR kv.expires_at > now())');
		expect(statements[0]!.values!.slice(1)).toEqual(statements[1]!.values!.slice(1));
		expect(statements[0]!.values![0]).toBe('guild_members');
	});
});
