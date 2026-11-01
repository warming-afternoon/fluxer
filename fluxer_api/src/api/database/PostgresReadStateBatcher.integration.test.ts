// SPDX-License-Identifier: AGPL-3.0-or-later

import {createChannelID, createMessageID, createUserID} from '@app/api/BrandedTypes';
import {ensurePostgresKvSchema, PostgresKvQueryExecutor} from '@app/api/database/PostgresKvQueryExecutor';
import type {ReadStateMutation} from '@app/api/database/ReadStateMutation';
import {ReadStates} from '@app/api/Tables';
import {
	getDefaultPostgresClient,
	type IPostgresClient,
	initPostgres,
	shutdownPostgres,
} from '@pkgs/postgres/src/Client';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

const testUrl = process.env.FLUXER_READ_STATE_TEST_POSTGRES_URL;
const kvTable = `kv_read_batch_${process.pid}`;

/** 构造可复用的确认操作，覆盖超出 Number 精度的用户 ID */
function ack(user: number, message = 100): ReadStateMutation {
	return {
		kind: 'ack',
		userId: createUserID(9007199254740993n + BigInt(user)),
		channelId: createChannelID(10n),
		messageId: createMessageID(BigInt(message)),
		mentionCount: 0,
	};
}

describe.skipIf(!testUrl)('PostgreSQL cross-request read state integration', () => {
	let client: IPostgresClient;
	let first: PostgresKvQueryExecutor;
	let second: PostgresKvQueryExecutor;
	const statements: Array<string | undefined> = [];

	beforeAll(async () => {
		await initPostgres({url: testUrl, kvTable, maxConnections: 4});
		client = getDefaultPostgresClient();
		await ensurePostgresKvSchema(client);
		const recording = {
			kvTable: () => kvTable,
			query: client.query.bind(client),
			transaction: <T>(fn: Parameters<IPostgresClient['transaction']>[0]) =>
				client.transaction((db) =>
					fn({
						query: (text: string, values?: Array<unknown>, name?: string) => {
							statements.push(name);
							return db.query(text, values, name);
						},
					}),
				) as Promise<T>,
		} as IPostgresClient;
		first = new PostgresKvQueryExecutor(recording);
		second = new PostgresKvQueryExecutor(recording);
	});
	beforeEach(async () => {
		await client.query(`DELETE FROM ${kvTable} WHERE table_name = 'read_states'`);
		statements.length = 0;
	});
	afterAll(async () => {
		await Promise.all([first?.shutdown(), second?.shutdown()]);
		if (client) await client.query(`DROP TABLE IF EXISTS ${kvTable}`);
		await shutdownPostgres();
	});

	it('persists hundreds of independent HTTP-shaped operations with bounded SQL batches', async () => {
		const results = await Promise.all(Array.from({length: 300}, (_, i) => first.executeReadStateMutations([ack(i)])));
		expect(results.every((result) => result[0]!.row!.message_id === 100n)).toBe(true);
		expect(statements.filter((name) => name === 'read_state_batch_read')).toHaveLength(3);
		expect(statements.filter((name) => name === 'read_state_batch_write')).toHaveLength(3);
		const stored = await client.query<{count: string}>(
			`SELECT count(*) FROM ${kvTable} WHERE table_name = 'read_states'`,
		);
		expect(Number(stored.rows[0]!.count)).toBe(300);
	});

	it('coordinates two independent batchers when incrementing a previously missing row', async () => {
		const base = ack(1);
		if (base.kind !== 'ack') throw new Error('expected ack');
		const mutation: ReadStateMutation = {
			kind: 'mention',
			userId: base.userId,
			channelId: base.channelId,
			messageId: createMessageID(200n),
		};
		await Promise.all(
			Array.from({length: 100}, (_, i) => (i % 2 ? first : second).executeReadStateMutations([mutation])),
		);
		const rows = await first.executeQuery(
			ReadStates.select({where: [ReadStates.where.eq('user_id'), ReadStates.where.eq('channel_id')]}).bind({
				user_id: base.userId,
				channel_id: base.channelId,
			}),
		);
		expect(rows[0]).toMatchObject({message_id: 10n, mention_count: 100});
	});

	it('returns ordered per-operation results while folding only final storage writes', async () => {
		const base = ack(1);
		if (base.kind !== 'ack') throw new Error('expected ack');
		const pin = new Date('2026-10-15T00:00:00Z');
		const results = await first.executeReadStateMutations([
			{...base, messageId: createMessageID(200n)},
			{...base, messageId: createMessageID(150n), manual: true},
			{kind: 'mention', userId: base.userId, channelId: base.channelId, messageId: createMessageID(201n)},
			{...base, messageId: createMessageID(140n)},
			{kind: 'pin', userId: base.userId, channelId: base.channelId, lastPinTimestamp: pin},
		]);
		expect(results.map((result) => result.row?.message_id)).toEqual([200n, 150n, 150n, 150n, 150n]);
		expect(results.at(-1)!.row).toMatchObject({mention_count: 1, last_pin_timestamp: pin});
		expect(statements.filter((name) => name === 'read_state_batch_write')).toHaveLength(1);
	});

	it('treats deletion as a barrier between older and newer acknowledgements', async () => {
		const base = ack(1);
		const pending = first.executeReadStateMutations([base, {kind: 'deleteUser', userId: base.userId}, ack(1, 300)]);
		const results = await pending;
		expect(results[1]).toEqual({previous: null, row: null, applied: true});
		const rows = await first.executeQuery(
			ReadStates.select({where: ReadStates.where.eq('user_id')}).bind({user_id: base.userId}),
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({message_id: 300n});
	});

	it('keeps ordinary cursors monotonic across competing batchers', async () => {
		await Promise.all(
			Array.from({length: 100}, (_, i) => (i % 2 ? first : second).executeReadStateMutations([ack(1, 1000 - i)])),
		);
		const rows = await first.executeQuery(
			ReadStates.select({where: ReadStates.where.eq('user_id')}).bind({user_id: ack(1).userId}),
		);
		expect(rows[0]).toMatchObject({message_id: 1000n});
	});

	it('rolls back the entire batch when a database write fails', async () => {
		await client.query(
			`ALTER TABLE ${kvTable} ADD CONSTRAINT reject_probe CHECK ((row_data ->> 'mention_count')::int IS DISTINCT FROM 9999)`,
		);
		try {
			const bad = ack(2);
			if (bad.kind !== 'ack') throw new Error('expected ack');
			await expect(first.executeReadStateMutations([ack(1), {...bad, mentionCount: 9999}])).rejects.toMatchObject({
				code: '23514',
			});
			const rows = await client.query(`SELECT row_key FROM ${kvTable} WHERE table_name = 'read_states'`);
			expect(rows.rows).toHaveLength(0);
		} finally {
			await client.query(`ALTER TABLE ${kvTable} DROP CONSTRAINT reject_probe`);
		}
	});
});
