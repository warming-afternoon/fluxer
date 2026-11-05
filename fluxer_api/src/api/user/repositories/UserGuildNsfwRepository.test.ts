// SPDX-License-Identifier: AGPL-3.0-or-later
import {createGuildID, createUserID} from '@app/api/BrandedTypes';
import {setCassandraQueryExecutorForTesting, upsertOne} from '@app/api/database/CassandraQueryExecution';
import {Db, type PreparedQuery} from '@app/api/database/CassandraTypes';
import {UserGuildSettings as SettingsTable} from '@app/api/Tables';
import {InMemoryCassandraQueryExecutor} from '@app/api/test/InMemoryCassandraQueryExecutor';
import {UserGuildNsfwRepository} from '@app/api/user/repositories/UserGuildNsfwRepository';
import {UserSettingsRepository} from '@app/api/user/repositories/UserSettingsRepository';
import {afterEach, beforeEach, expect, it} from 'vitest';

const user = createUserID(9007199254740993n),
	guild = createGuildID(9007199254740994n);
const repo = new UserGuildNsfwRepository();
beforeEach(() => setCassandraQueryExecutorForTesting(new InMemoryCassandraQueryExecutor()));
afterEach(() => setCassandraQueryExecutorForTesting(null));
it('missing row is hidden at version zero, separate from any age rule', async () => {
	const state = await repo.get(user, guild);
	expect(state.showNsfw).toBe(false);
	expect(state.nsfwVersion).toBe(0);
});
it('CAS stores a native bigint version and supports exact retry after uncertainty', async () => {
	const one = await repo.compareAndSet(user, guild, true, 0);
	expect(one.showNsfw).toBe(true);
	expect(one.nsfwVersion).toBe(1);
	expect((await repo.get(user, guild)).toRow().nsfw_version).toBe(1n);
	expect((await repo.compareAndSet(user, guild, true, 0)).nsfwVersion).toBe(1);
	await expect(repo.compareAndSet(user, guild, false, 0)).rejects.toMatchObject({code: 'STALE_VERSION'});
	const two = await repo.compareAndSet(user, guild, false, 1);
	expect(two.nsfwVersion).toBe(2);
	expect(two.showNsfw).toBe(false);
	await expect(repo.compareAndSet(user, guild, true, 0)).rejects.toMatchObject({code: 'STALE_VERSION'});
});
it('concurrent opposite CAS writes never share a winning version', async () => {
	const result = await Promise.allSettled([
		repo.compareAndSet(user, guild, true, 0),
		repo.compareAndSet(user, guild, false, 0),
	]);
	expect(result.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
	expect((await repo.get(user, guild)).nsfwVersion).toBe(1);
});
it('ordinary notification saves cannot overwrite a newer NSFW pair', async () => {
	const initial = await repo.compareAndSet(user, guild, true, 0);
	const stale = initial.toRow();
	await repo.compareAndSet(user, guild, false, 1);
	await new UserSettingsRepository().upsertGuildSettings({...stale, muted: true});
	const state = await repo.get(user, guild);
	expect(state.showNsfw).toBe(false);
	expect(state.nsfwVersion).toBe(2);
	expect(state.muted).toBe(true);
});
it('does not cross guild or user boundaries', async () => {
	await repo.compareAndSet(user, guild, true, 0);
	expect((await repo.get(createUserID(user + 1n), guild)).showNsfw).toBe(false);
	expect((await repo.get(user, createGuildID(guild + 1n))).showNsfw).toBe(false);
});
it.each([-1, NaN, 1.2, Number.MAX_SAFE_INTEGER])('rejects invalid/exhausted version %s', async (version) => {
	await expect(repo.compareAndSet(user, guild, true, version)).rejects.toMatchObject({code: 'INVALID_REQUEST'});
});

it('retries an unrelated first-write race without falsely reporting stale NSFW version', async () => {
	const row = (await repo.get(user, guild)).toRow();
	class Race extends InMemoryCassandraQueryExecutor {
		raced = false;
		override async executeQuery<T>(query: PreparedQuery): Promise<Array<T>> {
			if (!this.raced && query.cql.includes(' IF ') && !query.cql.includes('IF NOT EXISTS')) {
				this.raced = true;
				await super.executeQuery(
					SettingsTable.patchByPk({user_id: user, guild_id: guild}, {version: Db.set(8), muted: Db.set(true)}),
				);
			}
			return super.executeQuery<T>(query);
		}
	}
	const executor = new Race();
	setCassandraQueryExecutorForTesting(executor);
	await upsertOne(SettingsTable.upsertAll({...row, version: 7}));
	const result = await repo.compareAndSet(user, guild, true, 0);
	expect(executor.raced).toBe(true);
	expect(result.nsfwVersion).toBe(1);
	expect(result.muted).toBe(true);
});
