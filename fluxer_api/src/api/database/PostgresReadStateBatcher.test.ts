// SPDX-License-Identifier: AGPL-3.0-or-later

import {createChannelID, createMessageID, createUserID} from '@app/api/BrandedTypes';
import {PostgresReadStateBatcher} from '@app/api/database/PostgresReadStateBatcher';
import {type ReadStateMutation, reduceReadStateMutation} from '@app/api/database/ReadStateMutation';
import type {ReadStateRow} from '@app/api/database/types/ChannelTypes';
import type {IPostgresClient} from '@pkgs/postgres/src/Client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

/** 构造不同用户对同一帖的单条确认 */
function ack(user = 1, message = 100): ReadStateMutation {
	return {
		kind: 'ack',
		userId: createUserID(BigInt(user)),
		channelId: createChannelID(10n),
		messageId: createMessageID(BigInt(message)),
		mentionCount: 0,
	};
}

/** 记录真实组批边界，用可控提交延迟验证成功返回时机 */
function fixture(options: ConstructorParameters<typeof PostgresReadStateBatcher>[2] = {}) {
	let commit = Promise.resolve();
	const query = vi.fn(async () => ({rows: []}));
	const transaction = vi.fn(async (callback: (db: unknown) => Promise<unknown>) => {
		const result = await callback({query});
		await commit;
		return result;
	});
	const client = {kvTable: () => 'kv_batch_test', transaction} as unknown as IPostgresClient;
	const batcher = new PostgresReadStateBatcher(
		client,
		{
			key: (user, channel) => `${user}/${channel}`,
			encode: (row) => ({
				user_id: row.user_id.toString(),
				channel_id: row.channel_id.toString(),
				message_id: row.message_id?.toString(),
			}),
			decode: (row) => row as ReadStateRow,
		},
		options,
	);
	return {
		batcher,
		query,
		transaction,
		holdCommit: () => {
			let release = () => {};
			commit = new Promise<void>((resolve) => {
				release = resolve;
			});
			return release;
		},
	};
}

describe('cross-request read state batching', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('groups independent users into one read and one write and waits for COMMIT', async () => {
		const {batcher, query, transaction, holdCommit} = fixture();
		const release = holdCommit();
		let completed = false;
		const pending = Promise.all(Array.from({length: 100}, (_, index) => batcher.enqueue([ack(index + 1)]))).then(
			(rows) => {
				completed = true;
				return rows;
			},
		);
		expect(transaction).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(10);
		expect(transaction).toHaveBeenCalledTimes(1);
		expect(query.mock.calls.filter((call) => (call as Array<unknown>)[2] === 'read_state_batch_read')).toHaveLength(1);
		expect(query.mock.calls.filter((call) => (call as Array<unknown>)[2] === 'read_state_batch_write')).toHaveLength(1);
		expect(completed).toBe(false);
		release();
		const rows = await pending;
		expect(rows.map((result) => result[0]!.row!.user_id)).toEqual(Array.from({length: 100}, (_, i) => BigInt(i + 1)));
		await batcher.shutdown();
	});

	it('rejects excess capacity without starting extra database work', async () => {
		const {batcher, transaction} = fixture({capacity: 2});
		const accepted = batcher.enqueue([ack(1), ack(2)]);
		await expect(batcher.enqueue([ack(3)])).rejects.toMatchObject({status: 503});
		await vi.advanceTimersByTimeAsync(10);
		await accepted;
		expect(transaction).toHaveBeenCalledTimes(1);
		await batcher.shutdown();
	});

	it('expires queued work while an earlier operation of the same user is blocked', async () => {
		const {batcher, transaction, holdCommit} = fixture({delayMs: 0, maxWaitMs: 50});
		const release = holdCommit();
		const first = batcher.enqueue([ack()]);
		const second = batcher.enqueue([ack(1, 200)]);
		const rejected = expect(second).rejects.toMatchObject({status: 503});
		await vi.advanceTimersByTimeAsync(51);
		await rejected;
		expect(transaction).toHaveBeenCalledTimes(1);
		release();
		await first;
		await batcher.shutdown();
	});

	it('propagates transaction failure instead of resolving successful results', async () => {
		const {batcher, transaction} = fixture();
		transaction.mockRejectedValueOnce(new Error('rollback'));
		const rejected = expect(batcher.enqueue([ack()])).rejects.toThrow('rollback');
		await vi.advanceTimersByTimeAsync(10);
		await rejected;
		expect(batcher.renderMetrics()).toContain('failures_total 1');
		await batcher.shutdown();
	});

	it('drains pending work immediately on shutdown and refuses new work', async () => {
		const {batcher, transaction} = fixture({delayMs: 100});
		const pending = batcher.enqueue([ack()]);
		await batcher.shutdown();
		await pending;
		expect(transaction).toHaveBeenCalledTimes(1);
		await expect(batcher.enqueue([ack(2)])).rejects.toMatchObject({status: 503});
	});

	it('preserves manual rollback, subsequent mention increments and stale acknowledgements', () => {
		const first = ack();
		if (first.kind !== 'ack') throw new Error('expected ack');
		let row = reduceReadStateMutation({...first, messageId: createMessageID(200n)}, null).row;
		row = reduceReadStateMutation({...first, manual: true, messageId: createMessageID(150n)}, row).row;
		row = reduceReadStateMutation(
			{kind: 'mention', userId: first.userId, channelId: first.channelId, messageId: createMessageID(201n)},
			row,
		).row;
		const stale = reduceReadStateMutation({...first, messageId: createMessageID(140n)}, row);
		expect(stale.applied).toBe(false);
		expect(stale.row).toMatchObject({message_id: 150n, mention_count: 1});
	});
});
