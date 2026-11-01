// SPDX-License-Identifier: AGPL-3.0-or-later

import {createGuildID, createUserID} from '@app/api/BrandedTypes';
import {setCassandraQueryExecutorForTesting, upsertOne} from '@app/api/database/CassandraQueryExecution';
import type {PreparedQuery} from '@app/api/database/CassandraTypes';
import type {UserGuildSettingsRow} from '@app/api/database/types/UserTypes';
import {UserGuildSettings as SettingsTable} from '@app/api/Tables';
import {InMemoryCassandraQueryExecutor} from '@app/api/test/InMemoryCassandraQueryExecutor';
import {UserSettingsRepository} from '@app/api/user/repositories/UserSettingsRepository';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@app/api/Logger', () => ({Logger: {warn: vi.fn()}}));
const guild = createGuildID(9007199254740993n),
	other = createGuildID(9007199254740994n);
/** 构造超过安全整数范围的测试用户 ID */
const user = (n: number) => createUserID(9007199254740993n + BigInt(n));
/** 构造用于验证通知设置字段与社区隔离的记录 */
const row = (n: number, g = guild) =>
	({user_id: user(n), guild_id: g, muted: true, mobile_push: true, version: 7}) as UserGuildSettingsRow;
class CountingExecutor extends InMemoryCassandraQueryExecutor {
	/** 实际读取记录 */
	queries: Array<PreparedQuery> = [];

	/** 当前在途操作数量 */
	active = 0;

	/** 同时在途操作的最大数量 */
	maxActive = 0;

	/** 记录实际读取和最大并发，验证批查没有退回逐用户查询 */
	override async executeQuery<T>(query: PreparedQuery): Promise<Array<T>> {
		if (query.kvMeta?.action === 'select' || query.cql.startsWith('SELECT')) this.queries.push(query);
		this.active++;
		this.maxActive = Math.max(this.maxActive, this.active);
		try {
			return await super.executeQuery<T>(query);
		} finally {
			this.active--;
		}
	}
}
let executor: CountingExecutor;
const repo = new UserSettingsRepository();
beforeEach(() => {
	executor = new CountingExecutor();
	setCassandraQueryExecutorForTesting(executor);
});
afterEach(() => setCassandraQueryExecutorForTesting(null));
describe('bounded user guild settings batch', () => {
	it('preserves order duplicates null misses and bigint precision', async () => {
		await upsertOne(SettingsTable.upsertAll(row(1)));
		await upsertOne(SettingsTable.upsertAll(row(2)));
		executor.queries = [];
		const r = await repo.findGuildSettingsBatch([user(2), user(3), user(1), user(2)], guild);
		expect(r.map((x) => x?.userId ?? null)).toEqual([user(2), null, user(1), user(2)]);
		expect(r[0]?.mobilePush).toBe(true);
		expect(r[2]?.version).toBe(7);
		expect(executor.queries).toHaveLength(1);
		expect(executor.queries[0]!.params.user_ids).toHaveLength(3);
	});
	it('isolates guilds and maps null guild to zero', async () => {
		await upsertOne(SettingsTable.upsertAll(row(1, other)));
		await upsertOne(SettingsTable.upsertAll(row(2, createGuildID(0n))));
		expect(await repo.findGuildSettingsBatch([user(1)], guild)).toEqual([null]);
		expect((await repo.findGuildSettingsBatch([user(1)], other))[0]?.guildId).toBe(other);
		expect((await repo.findGuildSettingsBatch([user(2)], null))[0]?.guildId).toBe(0n);
	});
	it('does no query for empty input', async () => {
		expect(await repo.findGuildSettingsBatch([], guild)).toEqual([]);
		expect(executor.queries).toHaveLength(0);
	});
	it('caps batches at200 and runs chunks sequentially', async () => {
		const ids = Array.from({length: 401}, (_, i) => user(i));
		expect(await repo.findGuildSettingsBatch(ids, guild)).toEqual(ids.map(() => null));
		expect(executor.queries.map((q) => (q.params.user_ids as Array<unknown>).length)).toEqual([200, 200, 1]);
		expect(executor.maxActive).toBe(1);
		for (const q of executor.queries) {
			expect(q.cql).toMatch(/user_id IN/);
			expect(q.cql).toMatch(/guild_id =/);
			expect(q.params.guild_id).toBe(guild);
		}
	});
	it('deduplicates across chunk boundaries', async () => {
		const ids = Array.from({length: 201}, (_, i) => user(i));
		const input = [...ids, ...ids];
		expect(await repo.findGuildSettingsBatch(input, guild)).toEqual(input.map(() => null));
		expect(executor.queries.map((q) => (q.params.user_ids as Array<unknown>).length)).toEqual([200, 1]);
	});
	it('propagates a failed chunk and does not start later chunks', async () => {
		const original = executor.executeQuery.bind(executor);
		let calls = 0;
		vi.spyOn(executor, 'executeQuery').mockImplementation(async (query) => {
			calls++;
			if (calls === 2) throw new Error('batch failed');
			return original(query);
		});
		const ids = Array.from({length: 401}, (_, i) => user(i));
		await expect(repo.findGuildSettingsBatch(ids, guild)).rejects.toThrow('batch failed');
		expect(calls).toBe(2);
	});
});
