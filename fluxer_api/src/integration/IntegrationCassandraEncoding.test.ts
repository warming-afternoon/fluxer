// SPDX-License-Identifier: AGPL-3.0-or-later

import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createChannelID, createUserID} from '@app/api/BrandedTypes';
import {ThreadPolicyRepository} from '@app/api/channel/services/thread/ThreadPolicyRepository';
import {readSafeIntegerVersion} from '@app/api/database/CassandraVersion';
import {IntegrationEventJournal} from '@app/integration/IntegrationEventJournal';
import {IntegrationIdentityRepository} from '@app/integration/IntegrationIdentityRepository';
import * as CassandraClient from '@pkgs/cassandra/src/Client';
import cassandra from 'cassandra-driver';
import {afterEach, describe, expect, it, vi} from 'vitest';

const require = createRequire(import.meta.url);
// The installed pinned driver codec, NOT a fake or a conversion copied into a test.
const Encoder = require('cassandra-driver/lib/encoder') as new (
	protocol: number,
	options: object,
) => {
	encode(value: unknown, type: {code: number}): Buffer;
};
const encoder = new Encoder(4, {encoding: {map: Map, set: Set, useBigIntAsLong: true, useBigIntAsVarint: true}});
const BIGINT = {code: cassandra.types.dataTypes.bigint};
const userId = createUserID(901n),
	threadId = createChannelID(903n);
function result(row: Record<string, unknown> | null = null) {
	return {first: () => row, rows: row ? [row] : [], wasApplied: () => true};
}
function client(execute: ReturnType<typeof vi.fn>) {
	vi.spyOn(CassandraClient, 'getClient').mockReturnValue({execute} as unknown as cassandra.Client);
}

describe('integration versions at the real Cassandra bigint codec boundary', () => {
	afterEach(() => vi.restoreAllMocks());
	it('uses the production encoding and schema: bigint rejects number but accepts the exact bigint', () => {
		const schema = readFileSync(new URL('./schema.cql', import.meta.url), 'utf8');
		expect(schema).toContain('binding_version bigint');
		expect(schema).toMatch(/thread_external_policies[\s\S]*?version bigint/);
		expect(() => encoder.encode(1_700_000_000_123, BIGINT)).toThrow('Not a valid BigInt value');
		expect(encoder.encode(1_700_000_000_123n, BIGINT).readBigInt64BE()).toBe(1_700_000_000_123n);
	});
	it('encodes actual setCurrent prepared parameters and preserves its numeric external version', async () => {
		const execute = vi.fn(async (sql: string, values: Array<unknown>) => {
			encoder.encode(sql.startsWith('SELECT') ? values[0] : values[3], BIGINT);
			if (sql.startsWith('SELECT')) return result({binding_version: 4n});
			expect(sql).toContain('binding_version = ?');
			expect(encoder.encode(values[1], BIGINT).readBigInt64BE()).toBe(1_700_000_000_123n);
			return result();
		});
		client(execute);
		expect(
			await new IntegrationIdentityRepository().setCurrent(
				userId,
				'synthetic-discord',
				'synthetic-operation',
				1_700_000_000_123,
			),
		).toBe(1_700_000_000_123);
		expect(execute).toHaveBeenCalledTimes(2);
	});
	it('encodes actual policy INSERT bigint version without changing the public numeric contract', async () => {
		const execute = vi.fn(async (sql: string, values: Array<unknown>) => {
			encoder.encode(values[0], BIGINT);
			encoder.encode(values[1], BIGINT);
			if (sql.startsWith('SELECT')) return result();
			expect(encoder.encode(values[5], BIGINT).readBigInt64BE()).toBe(2n);
			return result();
		});
		client(execute);
		await new ThreadPolicyRepository().set(threadId, userId, {
			source: 'synthetic-policy',
			kind: 'lock',
			active: true,
			version: 2,
			expires_at: null,
		});
		expect(execute).toHaveBeenCalledTimes(2);
	});
	it('encodes actual policy UPDATE and IF-version as bigint while keeping the previous-version CAS', async () => {
		const execute = vi.fn(async (sql: string, values: Array<unknown>) => {
			if (sql.startsWith('SELECT')) return result({version: 2n});
			for (const index of [2, 4, 5, 7]) encoder.encode(values[index], BIGINT);
			expect(values[2]).toBe(3n);
			expect(values[7]).toBe(2n);
			return result();
		});
		client(execute);
		await new ThreadPolicyRepository().set(threadId, userId, {
			source: 'synthetic-policy',
			kind: 'lock',
			active: false,
			version: 3,
			expires_at: null,
		});
	});
	it('keeps exact positive safe-integer boundaries and rejects malformed or lossy versions', () => {
		for (const value of [1, 1n, Number.MAX_SAFE_INTEGER, BigInt(Number.MAX_SAFE_INTEGER)])
			expect(readSafeIntegerVersion(value)).toBe(Number(value));
		for (const value of [
			0,
			0n,
			-1,
			-1n,
			1.5,
			NaN,
			Infinity,
			Number.MAX_SAFE_INTEGER + 1,
			BigInt(Number.MAX_SAFE_INTEGER) + 1n,
			'2',
			null,
			{},
			undefined,
		])
			expect(() => readSafeIntegerVersion(value)).toThrow('Invalid Cassandra version');
		expect(readSafeIntegerVersion(0n, 0)).toBe(0);
	});
	it('rejects invalid identity request versions before even reading the database', async () => {
		const execute = vi.fn();
		client(execute);
		for (const version of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
			await expect(
				new IntegrationIdentityRepository().setCurrent(userId, 'synthetic-discord', 'op', version),
			).rejects.toThrow('Invalid Cassandra version');
		expect(execute).not.toHaveBeenCalled();
	});
	it('rejects corrupt identity reads and increment overflow without a write', async () => {
		for (const version of [0n, -1n, BigInt(Number.MAX_SAFE_INTEGER) + 1n, Number.MAX_SAFE_INTEGER + 1, NaN, '4']) {
			const execute = vi.fn(async () => result({binding_version: version}));
			client(execute);
			await expect(new IntegrationIdentityRepository().bindingVersion(userId)).rejects.toThrow(
				'Invalid Cassandra version',
			);
			await expect(
				new IntegrationIdentityRepository().setCurrent(userId, 'synthetic-discord', 'op', 4),
			).rejects.toThrow('Invalid Cassandra version');
			expect(execute).toHaveBeenCalledTimes(2);
		}
		const execute = vi.fn(async () => result({binding_version: BigInt(Number.MAX_SAFE_INTEGER)}));
		client(execute);
		await expect(new IntegrationIdentityRepository().setCurrent(userId, 'synthetic-discord', 'op', 4)).rejects.toThrow(
			'Invalid Cassandra version',
		);
		expect(execute).toHaveBeenCalledTimes(1);
	});
	it('preserves same-operation replay and max-safe numeric readback without another write', async () => {
		const execute = vi.fn(async () =>
			result({binding_version: BigInt(Number.MAX_SAFE_INTEGER), binding_operation: 'op'}),
		);
		client(execute);
		const repository = new IntegrationIdentityRepository();
		expect(await repository.setCurrent(userId, 'synthetic-discord', 'op', 4)).toBe(Number.MAX_SAFE_INTEGER);
		expect(await repository.bindingVersion(userId)).toBe(Number.MAX_SAFE_INTEGER);
		expect(execute).toHaveBeenCalledTimes(2);
	});
	it('normalizes list versions to JSON-safe numbers and rejects invalid policy inputs/reads', async () => {
		const execute = vi.fn(async () => result({source: 'synthetic-policy', version: 5n}));
		client(execute);
		const repository = new ThreadPolicyRepository();
		expect((await repository.list(threadId, userId))[0]?.version).toBe(5);
		for (const version of [0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
			execute.mockClear();
			await expect(
				repository.set(threadId, userId, {
					source: 'synthetic-policy',
					kind: 'lock',
					active: true,
					version,
					expires_at: null,
				}),
			).rejects.toThrow('Invalid Cassandra version');
			expect(execute).not.toHaveBeenCalled();
		}
		execute.mockImplementation(async () => result({version: BigInt(Number.MAX_SAFE_INTEGER) + 1n}));
		await expect(repository.list(threadId, userId)).rejects.toThrow('Invalid Cassandra version');
		await expect(
			repository.set(threadId, userId, {
				source: 'synthetic-policy',
				kind: 'lock',
				active: true,
				version: 8,
				expires_at: null,
			}),
		).rejects.toThrow('Invalid Cassandra version');
	});
	it('preserves stale-policy no-op, equal-payload replay and conflicting same-version rejection', async () => {
		const execute = vi.fn(async () => result({version: 5n, kind: 'lock', active: true, expires_at: null}));
		client(execute);
		const repository = new ThreadPolicyRepository();
		for (const version of [4, 5])
			await repository.set(threadId, userId, {
				source: 'synthetic-policy',
				kind: 'lock',
				active: true,
				version,
				expires_at: null,
			});
		await expect(
			repository.set(threadId, userId, {
				source: 'synthetic-policy',
				kind: 'lock',
				active: false,
				version: 5,
				expires_at: null,
			}),
		).rejects.toThrow('Same policy version');
		expect(execute).toHaveBeenCalledTimes(3);
	});
	it('keeps journal bigint CQL parameters and numeric JSON state_version exact', async () => {
		const execute = vi.fn(async (sql: string, values: Array<unknown>) => {
			if (sql.startsWith('SELECT')) return result({version: 4n});
			if (sql.startsWith('INSERT')) {
				encoder.encode(values[2], BIGINT);
				return result();
			}
			for (const index of [0, 4, 9]) encoder.encode(values[index], BIGINT);
			expect(JSON.parse(values[8] as string).state_version).toBe(5);
			return result({'[applied]': true});
		});
		client(execute);
		await new IntegrationEventJournal().snapshot('synthetic-resource', 'synthetic-subject', {synthetic: true});
		expect(execute).toHaveBeenCalledTimes(4);
	});
	it('does not emit or batch a journal version that cannot fit its JSON contract', async () => {
		const execute = vi.fn(async (_sql: string) => result({version: BigInt(Number.MAX_SAFE_INTEGER)}));
		client(execute);
		await expect(new IntegrationEventJournal().snapshot('synthetic-resource', 'synthetic-subject', {})).rejects.toThrow(
			'Invalid Cassandra version',
		);
		expect(execute).toHaveBeenCalledTimes(3);
		expect(execute.mock.calls.some(([sql]) => String(sql).startsWith('BEGIN BATCH'))).toBe(false);
	});
});
