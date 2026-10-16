// SPDX-License-Identifier: AGPL-3.0-or-later

import {createChannelID, createGuildID, createMessageID, createUserID} from '@app/api/BrandedTypes';
import {
	getCassandraMetadataInvalidations,
	mergeMetadataInvalidations,
} from '@app/api/database/CassandraMetadataTargets';
import {Db} from '@app/api/database/CassandraTypes';
import {Channels, Guilds, ReadStates} from '@app/api/Tables';
import {describe, expect, it, vi} from 'vitest';

vi.mock('@app/api/Config', () => ({Config: {nodeEnv: 'test'}}));

const channel = createChannelID(1n);
const guild = createGuildID(2n);

/** 使用真实 DSL 的查询与绑定参数验证目标提取。 */
function changes(query: ReturnType<typeof Channels.patchByPk>) {
	return getCassandraMetadataInvalidations(query.cql, query.params, query.kvMeta);
}

describe('Cassandra metadata invalidation targets', () => {
	it('invalidates only the modified channel, including soft deletion and TTL changes', () => {
		for (const patch of [{type: Db.set(11)}, {guild_id: Db.set(guild)}]) {
			expect(changes(Channels.patchByPk({channel_id: channel, soft_deleted: false}, patch))).toEqual([
				{entity: 'channel', ids: ['1']},
			]);
		}
		const ttl = Channels.patchByPkWithTtl({channel_id: channel, soft_deleted: false}, {type: Db.set(11)}, 5);
		expect(changes(ttl)).toEqual([{entity: 'channel', ids: ['1']}]);
		expect(changes(Channels.deleteByPk({channel_id: channel, soft_deleted: false}))).toEqual([
			{entity: 'channel', ids: ['1']},
		]);
	});

	it('skips unrelated fields, reads and non-metadata writes', () => {
		expect(
			changes(
				Channels.patchByPk({channel_id: channel, soft_deleted: false}, {last_message_id: Db.set(createMessageID(3n))}),
			),
		).toEqual([]);
		expect(changes(Guilds.patchByPk({guild_id: guild}, {name: Db.set('test')}))).toEqual([]);
		expect(
			changes(
				ReadStates.patchByPk(
					{user_id: createUserID(4n), channel_id: channel},
					{message_id: Db.set(createMessageID(3n))},
				),
			),
		).toEqual([]);
		expect(getCassandraMetadataInvalidations('UPDATE read_states SET message_id = :id', {id: 3n})).toEqual([]);
		expect(getCassandraMetadataInvalidations('SELECT type FROM channels', {})).toEqual([]);
	});

	it('extracts guild feature updates, custom bindings and old/new IDs', () => {
		expect(changes(Guilds.patchByPk({guild_id: guild}, {features: Db.set(new Set())}))).toEqual([
			{entity: 'guild', ids: ['2']},
		]);
		const meta = {
			action: 'patch' as const,
			table: Channels,
			where: [{kind: 'eq' as const, col: 'channel_id', param: 'old'}],
			patch: {channel_id: Db.set(9n)},
		};
		expect(
			getCassandraMetadataInvalidations(
				'UPDATE channels SET channel_id=:new WHERE channel_id=:old',
				{old: 1n, new: 9n},
				meta,
			),
		).toEqual([{entity: 'channel', ids: ['1', '9']}]);
	});

	it('handles conditional batches and IN deletes without losing precision', () => {
		const batch = Channels.conditionalBatch([
			{action: 'patch', pk: {channel_id: channel, soft_deleted: false}, patch: {type: Db.set(11)}, expected: {type: 0}},
		]);
		expect(changes(batch)).toEqual([{entity: 'channel', ids: ['1']}]);
		const meta = {
			action: 'delete' as const,
			table: Channels,
			where: [{kind: 'in' as const, col: 'channel_id', param: 'ids'}],
		};
		expect(
			getCassandraMetadataInvalidations('DELETE FROM channels WHERE channel_id IN :ids', {ids: [1n, 2n, 1n]}, meta),
		).toEqual([{entity: 'channel', ids: ['1', '2']}]);
	});

	it('falls back by category and clears both only for completely unknown writes', () => {
		expect(getCassandraMetadataInvalidations('TRUNCATE channels', {})).toEqual([{entity: 'channel', ids: null}]);
		expect(getCassandraMetadataInvalidations('UPDATE guilds SET features=:features', {features: new Set()})).toEqual([
			{entity: 'guild', ids: null},
		]);
		expect(getCassandraMetadataInvalidations('BEGIN BATCH APPLY BATCH', {})).toEqual([
			{entity: 'channel', ids: null},
			{entity: 'guild', ids: null},
		]);
		expect(
			mergeMetadataInvalidations([
				{entity: 'channel', ids: ['1']},
				{entity: 'channel', ids: null},
				{entity: 'guild', ids: ['2', '2']},
			]),
		).toEqual([
			{entity: 'channel', ids: null},
			{entity: 'guild', ids: ['2']},
		]);
	});
});
