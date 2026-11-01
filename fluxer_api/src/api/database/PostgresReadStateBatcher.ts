// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	type ReadStateMutation,
	type ReadStateMutationResult,
	reduceReadStateMutation,
} from '@app/api/database/ReadStateMutation';
import type {ReadStateRow} from '@app/api/database/types/ChannelTypes';
import {ServiceUnavailableError} from '@fluxer/errors/src/domains/core/ServiceUnavailableError';
import {type IPostgresClient, quoteIdentifier} from '@pkgs/postgres/src/Client';

interface RowCodec {
	/** 使用现有 KV 主键编码 */
	key: (userId: bigint, channelId: bigint) => string;

	/** 保留 bigint 和日期的现有编码 */
	encode: (row: ReadStateRow) => Record<string, unknown>;

	/** 从已有 KV 行恢复状态 */
	decode: (value: unknown) => ReadStateRow;
}

interface BatchOptions {
	/** 主动收集操作的窗口 */
	delayMs: number;

	/** 每批最多操作数 */
	batchSize: number;

	/** 包含执行中操作的总容量 */
	capacity: number;

	/** 尚未执行操作的最长等待 */
	maxWaitMs: number;

	/** 同时占用的数据库连接数 */
	concurrency: number;
}

interface PendingMutation {
	/** 已验证的业务变更 */
	mutation: ReadStateMutation;

	/** 用于收集窗口和超时判断的入队时间 */
	at: number;

	/** 仅在事务提交之后返回结果 */
	resolve: (result: ReadStateMutationResult) => void;

	/** 未执行或事务失败时通知调用方 */
	reject: (error: unknown) => void;
}

const DEFAULT_OPTIONS: BatchOptions = {delayMs: 10, batchSize: 128, capacity: 8192, maxWaitMs: 5000, concurrency: 2};

/** 在进程内跨请求组批，事务提交前不确认保存成功 */
export class PostgresReadStateBatcher {
	private readonly options: BatchOptions;
	private readonly table: string;
	private readonly queues = new Map<string, Array<PendingMutation>>();
	private readonly activeUsers = new Set<string>();
	private readonly running = new Set<Array<PendingMutation>>();
	private timer: ReturnType<typeof setTimeout> | null = null;
	private pending = 0;
	private stopping = false;
	private drained: (() => void) | null = null;
	private batches = 0;
	private operations = 0;
	private rejected = 0;
	private expired = 0;
	private failures = 0;
	private writtenRows = 0;
	private retries = 0;
	private shutdownPromise: Promise<void> | null = null;

	/** 固定容量和并发，避免高峰将数据库连接池占满 */
	constructor(
		private readonly client: IPostgresClient,
		private readonly codec: RowCodec,
		options: Partial<BatchOptions> = {},
	) {
		this.options = {...DEFAULT_OPTIONS, ...options};
		for (const [name, value] of Object.entries(this.options)) {
			if (!Number.isSafeInteger(value) || value < (name === 'delayMs' ? 0 : 1))
				throw new RangeError(`Invalid read-state batch option: ${name}`);
		}
		this.table = quoteIdentifier(client.kvTable());
	}

	/** 整组检查容量后入队，避免容量不足时只接收请求的一部分 */
	enqueue(mutations: ReadonlyArray<ReadStateMutation>): Promise<Array<ReadStateMutationResult>> {
		if (mutations.length === 0) return Promise.resolve([]);
		if (this.stopping || this.pending + mutations.length > this.options.capacity) {
			this.rejected += mutations.length;
			return Promise.reject(new ServiceUnavailableError({headers: {'Retry-After': '1'}}));
		}
		const promises = mutations.map(
			(mutation) =>
				new Promise<ReadStateMutationResult>((resolve, reject) => {
					const user = mutation.userId.toString();
					const queue = this.queues.get(user) ?? [];
					queue.push({mutation, at: Date.now(), resolve, reject});
					this.queues.set(user, queue);
					this.pending++;
				}),
		);
		this.schedule();
		return Promise.all(promises);
	}

	/** 暴露无用户数据的队列水位和处理计数 */
	renderMetrics(): string {
		const oldest = Math.min(Date.now(), ...Array.from(this.queues.values(), (queue) => queue[0]?.at ?? Date.now()));
		return `${Object.entries({
			pending: this.pending,
			inflight_batches: this.running.size,
			oldest_queued_seconds: (Date.now() - oldest) / 1000,
			batches_total: this.batches,
			operations_total: this.operations,
			rejected_total: this.rejected,
			expired_total: this.expired,
			failures_total: this.failures,
			written_rows_total: this.writtenRows,
			retries_total: this.retries,
		})
			.map(([key, value]) => `fluxer_read_state_batch_${key} ${value}`)
			.join('\n')}\n`;
	}

	/** 停止接收新操作，先排空缓冲区再允许关闭数据库 */
	async shutdown(): Promise<void> {
		this.shutdownPromise ??= this.drain();
		return this.shutdownPromise;
	}

	/** 排空过程只创建一次，避免并发停机覆盖等待者 */
	private async drain(): Promise<void> {
		this.stopping = true;
		if (this.pending === 0) return;
		const drained = new Promise<void>((resolve) => {
			this.drained = resolve;
		});
		const timeout = setTimeout(() => {
			if (this.timer) {
				clearTimeout(this.timer);
				this.timer = null;
			}
			const error = new ServiceUnavailableError({headers: {'Retry-After': '1'}});
			for (const queue of this.queues.values()) {
				for (const item of queue) {
					item.reject(error);
					this.pending--;
				}
			}
			this.queues.clear();
			// 执行中事务结果不确定时返回失败，数据库客户端仍负责等待连接安全退出。
			for (const batch of this.running) for (const item of batch) item.reject(error);
			this.drained?.();
		}, 10000);
		this.schedule();
		await drained;
		clearTimeout(timeout);
	}

	/** 到期即组批，同时按用户保持顺序并限制数据库并发 */
	private schedule(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		const now = Date.now();
		for (const [user, queue] of this.queues) {
			while (queue[0] && now - queue[0].at >= this.options.maxWaitMs) {
				queue.shift()!.reject(new ServiceUnavailableError({headers: {'Retry-After': '1'}}));
				this.pending--;
				this.expired++;
			}
			if (queue.length === 0) this.queues.delete(user);
		}
		if (this.pending === 0) {
			this.drained?.();
			return;
		}
		const ready = Array.from(this.queues).filter(([user]) => !this.activeUsers.has(user));
		const count = ready.reduce((sum, [, queue]) => sum + queue.length, 0);
		const oldest = Math.min(now, ...ready.map(([, queue]) => queue[0]!.at));
		if (
			count &&
			this.running.size < this.options.concurrency &&
			(this.stopping || count >= this.options.batchSize || now - oldest >= this.options.delayMs)
		) {
			const batch: Array<PendingMutation> = [];
			for (const [user, queue] of ready) {
				// 删除是独立屏障，不能与该用户其他操作在同批重新创建数据。
				if (queue[0]!.mutation.kind === 'deleteUser' && batch.length) continue;
				const take =
					queue[0]!.mutation.kind === 'deleteUser'
						? 1
						: Math.min(
								this.options.batchSize - batch.length,
								queue.findIndex((item) => item.mutation.kind === 'deleteUser') < 0
									? queue.length
									: queue.findIndex((item) => item.mutation.kind === 'deleteUser'),
							);
				batch.push(...queue.splice(0, take));
				this.activeUsers.add(user);
				// 将仍有剩余操作的用户移到末尾，避免单用户长期抢占。
				this.queues.delete(user);
				if (queue.length) this.queues.set(user, queue);
				if (batch.length >= this.options.batchSize || batch[0]!.mutation.kind === 'deleteUser') break;
			}
			this.running.add(batch);
			void this.flush(batch).finally(() => {
				this.running.delete(batch);
				for (const item of batch) this.activeUsers.delete(item.mutation.userId.toString());
				this.pending -= batch.length;
				if (this.pending === 0) this.drained?.();
				this.schedule();
			});
			this.schedule();
			return;
		}
		if (this.queues.size) {
			const expiry = Math.min(...Array.from(this.queues.values(), (queue) => queue[0]!.at + this.options.maxWaitMs));
			const collect = count && this.running.size < this.options.concurrency ? oldest + this.options.delayMs : expiry;
			this.timer = setTimeout(() => this.schedule(), Math.max(1, Math.min(expiry, collect) - now));
		}
	}

	/** 在同一连接内锁定、批量读取、折叠和写入，并在 COMMIT 之后返回 */
	private async flush(batch: Array<PendingMutation>): Promise<void> {
		try {
			const transaction = () =>
				this.client.transaction(async (db) => {
					// 事务锁也覆盖尚不存在的行；按锁值排序，避免不同 API 交叉拿锁。
					await db.query("SET LOCAL statement_timeout = '3s'; SET LOCAL lock_timeout = '1s'");
					await db.query(
						`SELECT pg_advisory_xact_lock(lock_key) FROM (
SELECT DISTINCT hashtextextended($1 || user_id, 0) AS lock_key FROM unnest($2::text[]) AS users(user_id) ORDER BY lock_key
) AS locks`,
						[
							`${this.client.kvTable()}:read_states:`,
							[...new Set(batch.map((item) => item.mutation.userId.toString()))],
						],
						'read_state_batch_locks',
					);
					if (batch[0]!.mutation.kind === 'deleteUser') {
						const user = batch[0]!.mutation.userId;
						await db.query(
							`DELETE FROM ${this.table} WHERE table_name = 'read_states' AND row_data -> 'user_id' = $1::jsonb`,
							[JSON.stringify({__fluxer_type: 'bigint', value: user.toString()})],
							'read_state_batch_delete_user',
						);
						return [{previous: null, row: null, applied: true}];
					}
					const mutations = batch
						.map((item) => item.mutation)
						.filter((item): item is Exclude<ReadStateMutation, {kind: 'deleteUser'}> => item.kind !== 'deleteUser');
					const keys = [...new Set(mutations.map((item) => this.codec.key(item.userId, item.channelId)))];
					const found = await db.query<{row_key: string; row_data: unknown}>(
						`SELECT row_key, row_data FROM ${this.table} WHERE table_name = 'read_states' AND row_key = ANY($1::text[]) AND (expires_at IS NULL OR expires_at > now())`,
						[keys],
						'read_state_batch_read',
					);
					const rows = new Map(found.rows.map((row) => [row.row_key, this.codec.decode(row.row_data)]));
					const changed = new Map<string, ReadStateRow>();
					const results = mutations.map((mutation) => {
						const key = this.codec.key(mutation.userId, mutation.channelId);
						const result = reduceReadStateMutation(mutation, rows.get(key) ?? null);
						if (result.applied && result.row) {
							rows.set(key, result.row);
							changed.set(key, result.row);
						}
						return result;
					});
					if (changed.size) {
						// 每个主键仅写最终行，使用固定参数形状避免随批大小积累预编译语句。
						const payload = [...changed].map(([row_key, row]) => ({row_key, row_data: this.codec.encode(row)}));
						await db.query(
							`INSERT INTO ${this.table} AS kv (table_name, partition_key, row_key, row_data, expires_at, updated_at)
SELECT 'read_states', item.row_key, item.row_key, item.row_data, NULL, now()
FROM jsonb_to_recordset($1::jsonb) AS item(row_key text, row_data jsonb)
ON CONFLICT (table_name, row_key) DO UPDATE SET row_data = EXCLUDED.row_data,
expires_at = CASE WHEN kv.expires_at <= now() THEN NULL ELSE kv.expires_at END, updated_at = now()`,
							[JSON.stringify(payload)],
							'read_state_batch_write',
						);
					}
					return results;
				});
			let results: Array<ReadStateMutationResult>;
			for (let attempt = 0; ; attempt++) {
				try {
					results = await transaction();
					break;
				} catch (error) {
					// 仅重试 PostgreSQL 明确保证已回滚的冲突，连接或提交不确定时不重放。
					const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
					if (attempt >= 2 || (code !== '40P01' && code !== '40001')) throw error;
					this.retries++;
					await new Promise((resolve) => setTimeout(resolve, 10 + Math.floor(Math.random() * 30)));
				}
			}
			this.batches++;
			this.operations += batch.length;
			this.writtenRows += new Set(
				batch
					.filter((_, index) => results[index]?.applied)
					.filter((item) => item.mutation.kind !== 'deleteUser')
					.map((item) =>
						item.mutation.kind === 'deleteUser' ? '' : this.codec.key(item.mutation.userId, item.mutation.channelId),
					),
			).size;
			for (let index = 0; index < batch.length; index++) batch[index]!.resolve(results[index]!);
		} catch (error) {
			// 不逐条回退或重放提交结果不明的提及增量，避免放大压力和重复计数。
			this.failures++;
			for (const item of batch) item.reject(error);
		}
	}
}
