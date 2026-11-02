// SPDX-License-Identifier: AGPL-3.0-or-later

import {beforeEach, describe, expect, it, vi} from 'vitest';

vi.hoisted(() => {
	vi.resetModules();
});

const store = vi.hoisted(() => ({rows: new Map<string, Record<string, unknown>>(), failBatch: false}));
vi.mock('@app/integration/IntegrationIdentityRepository', () => ({INTEGRATION_QUERY_OPTIONS: {prepare: true}}));
vi.mock('@pkgs/cassandra/src/Client', () => ({
	getClient: () => ({
		execute: async (query: string, values: Array<unknown>) => {
			const result = (row?: Record<string, unknown>) => ({first: () => row, rows: row ? [row] : []});
			if (query.startsWith('BEGIN BATCH')) {
				if (store.failBatch) throw new Error('authority unavailable');
				const [version, fingerprint, shard, key, previous, , eventKey, subject, payload] = values;
				const row = store.rows.get(`${shard}/${key}`);
				if (row?.version !== previous) return result({'[applied]': false});
				store.rows.set(`${shard}/${key}`, {...row, version, fingerprint});
				store.rows.set(`${shard}/${eventKey}`, {subject, payload});
				return result({'[applied]': true});
			}
			if (query.startsWith('SELECT')) return result(store.rows.get(`${values[0]}/${values[1]}`));
			if (query.startsWith('INSERT')) {
				const [shard, key, value] = values;
				const id = `${shard}/${key}`;
				if (query.includes('IF NOT EXISTS') && store.rows.has(id)) return result({'[applied]': false});
				store.rows.set(id, query.includes('version)') ? {version: value} : {payload: value});
				return result({'[applied]': true});
			}
			if (query.startsWith('UPDATE')) {
				const [payload, shard, key, previous] = values;
				const row = store.rows.get(`${shard}/${key}`);
				if (row?.payload !== previous) return result({'[applied]': false});
				store.rows.set(`${shard}/${key}`, {payload});
				return result({'[applied]': true});
			}
			throw new Error(`Unexpected query ${query}`);
		},
	}),
}));

import {IntegrationEventJournal} from '@app/integration/IntegrationEventJournal';

describe('IntegrationEventJournal', () => {
	beforeEach(() => {
		store.rows.clear();
		store.failBatch = false;
	});
	it('keeps duplicate snapshots at one stable revision and journals changed reactions separately', async () => {
		const journal = new IntegrationEventJournal();
		await journal.snapshot('thread:11', 'events.content.v1.thread.changed', {snapshot: {reactions: []}});
		await journal.snapshot('thread:11', 'events.content.v1.thread.changed', {snapshot: {reactions: []}});
		await journal.snapshot('thread:11', 'events.content.v1.thread.changed', {
			snapshot: {reactions: [{emoji: {id: null, name: '👍'}, count: 1}]},
		});
		const pending = [...store.rows]
			.filter(([key]) => key.includes('/p:'))
			.map(([, row]) => JSON.parse(String(row.payload)));
		expect(pending.map((event) => event.event_id)).toEqual(['thread:11:1', 'thread:11:2']);
		expect(pending.map((event) => event.state_version)).toEqual([1, 2]);
	});
	it('does not advance the version when the atomic state-and-outbox batch fails', async () => {
		const journal = new IntegrationEventJournal();
		store.failBatch = true;
		await expect(
			journal.snapshot('thread:11', 'events.content.v1.thread.changed', {snapshot: {title: 'A'}}),
		).rejects.toThrow('authority unavailable');
		expect([...store.rows.values()].find((row) => 'version' in row)?.version).toBe(0n);
		expect([...store.rows.keys()].some((key) => key.includes('/p:'))).toBe(false);
		store.failBatch = false;
		await journal.snapshot('thread:11', 'events.content.v1.thread.changed', {snapshot: {title: 'A'}});
		expect([...store.rows.keys()].some((key) => key.endsWith('/p:thread:11:1'))).toBe(true);
	});
	it('preserves a deletion intent when a concurrent directory reconciliation touches the resource', async () => {
		const journal = new IntegrationEventJournal();
		await journal.track('thread:11', {thread_id: '11', deleting: true, creation_operation_id: 'task-12'});
		await journal.track('thread:11', {thread_id: '11'});
		expect(await journal.resource('thread:11')).toEqual({
			thread_id: '11',
			deleting: true,
			creation_operation_id: 'task-12',
		});
	});
});
