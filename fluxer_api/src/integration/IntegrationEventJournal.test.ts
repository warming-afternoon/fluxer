// SPDX-License-Identifier: AGPL-3.0-or-later

import {beforeEach, describe, expect, it, vi} from 'vitest';

vi.hoisted(() => {
	vi.resetModules();
});

const store = vi.hoisted(() => ({rows: new Map<string, Record<string, unknown>>(), failBatch: false, conflict: false}));
vi.mock('@app/integration/IntegrationIdentityRepository', () => ({INTEGRATION_QUERY_OPTIONS: {prepare: true}}));
vi.mock('@pkgs/cassandra/src/Client', () => ({
	getClient: () => ({
		execute: async (query: string, values: Array<unknown>) => {
			const result = (row?: Record<string, unknown>) => ({first: () => row, rows: row ? [row] : []});
			if (query.startsWith('BEGIN BATCH')) {
				if (store.failBatch) throw new Error('authority unavailable');
				if (store.conflict) return result({'[applied]': false});
				const [version, fingerprint, shard, key, previous, , eventKey, subject, payload, , , trackedKey] = values;
				const row = store.rows.get(`${shard}/${key}`);
				if (row?.version !== previous) return result({'[applied]': false});
				store.rows.set(`${shard}/${key}`, {...row, version, fingerprint});
				store.rows.set(`${shard}/${eventKey}`, {subject, payload});
				store.rows.set(`${shard}/${trackedKey}`, {...store.rows.get(`${shard}/${trackedKey}`), version});
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
				if (query.includes(' IF ') && row?.payload !== previous) return result({'[applied]': false});
				store.rows.set(`${shard}/${key}`, {...row, payload});
				return result({'[applied]': true});
			}
			if (query.startsWith('DELETE')) {
				if (query.includes('entry_key >=')) {
					for (const key of store.rows.keys())
						if (key >= `${values[0]}/${values[1]}` && key < `${values[0]}/${values[2]}`) store.rows.delete(key);
				} else store.rows.delete(`${values[0]}/${values[1]}`);
				return result();
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
		store.conflict = false;
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
	it('does not promote a stale snapshot after a CAS conflict and preserves a high-water mark if the state row is rebuilt', async () => {
		const journal = new IntegrationEventJournal();
		store.conflict = true;
		await expect(
			journal.snapshot('thread:11', 'events.content.v1.thread.changed', {snapshot: {title: 'old'}}),
		).rejects.toThrow('CAS conflict');
		expect([...store.rows.keys()].some((key) => key.includes('/p:'))).toBe(false);
		store.conflict = false;
		await journal.snapshot('thread:11', 'events.content.v1.thread.changed', {snapshot: {title: 'new'}});
		for (const key of store.rows.keys()) if (key.includes('/s:')) store.rows.delete(key);
		await journal.snapshot('thread:11', 'events.content.v1.thread.deleted', {snapshot: {title: ''}});
		expect([...store.rows.keys()].some((key) => key.endsWith('/p:thread:11:2'))).toBe(true);
	});
	it('removes terminal creation pending rows but retains the failure marker and never retracks the orphan', async () => {
		const journal = new IntegrationEventJournal();
		await journal.track('thread:11', {thread_id: '11', creation_operation_id: 'task-12'});
		await journal.snapshot('thread:11', 'events.content.v1.thread.changed', {snapshot: {title: 'temporary'}});
		await journal.failCreation('thread:11', 'task-12');
		expect([...store.rows.keys()].some((key) => key.includes('/p:') || key.includes('/d:'))).toBe(false);
		expect(await journal.resource('thread:11')).toEqual({creation_operation_id: 'task-12', creation_failed: true});
		await journal.track('thread:11', {thread_id: '11'});
		expect([...store.rows.keys()].some((key) => key.includes('/d:'))).toBe(false);
	});
	it('allocates independent versions for native tag additions and removals', async () => {
		const journal = new IntegrationEventJournal();
		await journal.snapshot('thread:11', 'events.content.v1.thread.changed', {
			snapshot: {tags: [{id: '7', name: '冒险'}]},
		});
		await journal.snapshot('thread:11', 'events.content.v1.thread.changed', {snapshot: {tags: []}});
		const pending = [...store.rows]
			.filter(([key]) => key.includes('/p:'))
			.map(([, row]) => JSON.parse(String(row.payload)));
		expect(pending.map((event) => event.state_version)).toEqual([1, 2]);
		expect(pending[1].snapshot.tags).toEqual([]);
	});
});
