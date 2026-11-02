// SPDX-License-Identifier: AGPL-3.0-or-later

import {createHash} from 'node:crypto';
import {readSafeIntegerVersion} from '@app/api/database/CassandraVersion';
import {INTEGRATION_QUERY_OPTIONS} from '@app/integration/IntegrationIdentityRepository';
import {getClient} from '@pkgs/cassandra/src/Client';

export interface JournalEvent {
	/** 稳定的传输主题 */
	subject: string;

	/** 已序列化的不可变事件 */
	payload: string;

	/** 待发分区 */
	shard: number;

	/** 待发记录主键 */
	key: string;
}

export class IntegrationEventJournal {
	/** 将内容摘要和待发事件写入同一分区的条件批次，版本不会与事件分离 */
	async snapshot(resource: string, subject: string, data: Record<string, unknown>): Promise<void> {
		const digest = createHash('sha256').update(resource).digest();
		const shard = digest[0]! % 16;
		const key = `s:${resource}`;
		const fingerprint = createHash('sha256').update(JSON.stringify({subject, data})).digest('hex');
		const tracked = await getClient().execute(
			'SELECT version FROM integration_event_journal WHERE shard = ? AND entry_key = ?',
			[shard, `d:${resource}`],
			INTEGRATION_QUERY_OPTIONS,
		);
		const highWater = BigInt(readSafeIntegerVersion(tracked.first()?.version ?? 0, 0));
		await getClient().execute(
			'INSERT INTO integration_event_journal (shard, entry_key, version) VALUES (?, ?, ?) IF NOT EXISTS',
			[shard, key, highWater],
			INTEGRATION_QUERY_OPTIONS,
		);
		{
			const response = await getClient().execute(
				'SELECT version, fingerprint FROM integration_event_journal WHERE shard = ? AND entry_key = ?',
				[shard, key],
				INTEGRATION_QUERY_OPTIONS,
			);
			const previous = response.first();
			const version = BigInt(readSafeIntegerVersion(previous?.version ?? 0, 0));
			if (previous?.fingerprint === fingerprint && version >= highWater) {
				if (version > highWater)
					await getClient().execute(
						'UPDATE integration_event_journal SET version = ? WHERE shard = ? AND entry_key = ? IF version = ?',
						[version, shard, `d:${resource}`, tracked.first()?.version == null ? null : highWater],
						INTEGRATION_QUERY_OPTIONS,
					);
				return;
			}
			let next = highWater;
			if (version > next) next = version;
			next += 1n;
			const publicVersion = readSafeIntegerVersion(next);
			const eventId = `${resource}:${next}`;
			const payload = JSON.stringify({
				...data,
				event_id: eventId,
				state_version: publicVersion,
				occurred_at: new Date().toISOString(),
			});
			const result = await getClient().execute(
				'BEGIN BATCH UPDATE integration_event_journal SET version = ?, fingerprint = ? WHERE shard = ? AND entry_key = ? IF version = ?; INSERT INTO integration_event_journal (shard, entry_key, subject, payload) VALUES (?, ?, ?, ?); UPDATE integration_event_journal SET version = ? WHERE shard = ? AND entry_key = ?; APPLY BATCH',
				[next, fingerprint, shard, key, version, shard, `p:${eventId}`, subject, payload, next, shard, `d:${resource}`],
				INTEGRATION_QUERY_OPTIONS,
			);
			if (result.first()?.['[applied]'] === true) return;
			// CAS 冲突后必须重新读取原生快照，不能给旧正文分配更大的事件版本。
			throw new Error('Integration snapshot CAS conflict; reread authoritative content');
		}
	}

	/** 在返回调用方前持久化认证事件，失败不能静默退化为尽力发布 */
	async enqueue(subject: string, data: Record<string, unknown>, eventId: string): Promise<void> {
		const shard = createHash('sha256').update(eventId).digest()[0]! % 16;
		const payload = JSON.stringify({...data, event_id: eventId, occurred_at: new Date().toISOString()});
		await getClient().execute(
			'INSERT INTO integration_event_journal (shard, entry_key, subject, payload) VALUES (?, ?, ?, ?) IF NOT EXISTS',
			[shard, `p:${eventId}`, subject, payload],
			INTEGRATION_QUERY_OPTIONS,
		);
	}

	/** 每次只读取一个分区的一页待发记录，游标绕回后覆盖后插入的小键 */
	async pending(shard: number, after = 'p:', limit = 100): Promise<Array<JournalEvent>> {
		const response = await getClient().execute(
			'SELECT entry_key, subject, payload FROM integration_event_journal WHERE shard = ? AND entry_key > ? AND entry_key < ? LIMIT ?',
			[shard, after, 'q:', limit],
			INTEGRATION_QUERY_OPTIONS,
		);
		return response.rows.map((row) => ({
			shard,
			key: String(row.entry_key),
			subject: String(row.subject),
			payload: String(row.payload),
		}));
	}

	/** 仅在远端 JetStream 已确认持久化后删除待发记录 */
	async acknowledge(event: JournalEvent): Promise<void> {
		await getClient().execute(
			'DELETE FROM integration_event_journal WHERE shard = ? AND entry_key = ?',
			[event.shard, event.key],
			INTEGRATION_QUERY_OPTIONS,
		);
	}

	/** 完整快照允许合并旧待发版本，版本记录缺失则保留待发而不是降级发送 */
	async superseded(event: JournalEvent, resource: string, version: number): Promise<boolean> {
		const response = await getClient().execute(
			'SELECT version FROM integration_event_journal WHERE shard = ? AND entry_key = ?',
			[event.shard, `s:${resource}`],
			INTEGRATION_QUERY_OPTIONS,
		);
		const current = response.first()?.version;
		if (current == null || readSafeIntegerVersion(current, 0) < readSafeIntegerVersion(version))
			throw new Error('Integration event version authority is missing or regressed');
		return readSafeIntegerVersion(current, 0) > readSafeIntegerVersion(version);
	}

	/** 业务写入前记录可重读资源，崩溃恢复不依赖已成功发送的网关事件 */
	async track(resource: string, data: Record<string, unknown>): Promise<void> {
		const shard = createHash('sha256').update(resource).digest()[0]! % 16;
		// 终止失败的创建不再进入持续跟踪，目录对账也不能把遗留线程当独立创建。
		if ((await this.resource(resource))?.creation_failed === true) return;
		for (let attempt = 0; attempt < 20; attempt++) {
			const response = await getClient().execute(
				'SELECT payload FROM integration_event_journal WHERE shard = ? AND entry_key = ?',
				[shard, `d:${resource}`],
				INTEGRATION_QUERY_OPTIONS,
			);
			const previous = response.first()?.payload as string | undefined;
			const old = previous ? JSON.parse(previous) : {};
			// 删除意图不会被并发目录对账或回复写入覆盖；Snowflake 资源不会复用。
			const payload = JSON.stringify({...old, ...data, ...(old.deleting ? {deleting: true} : {})});
			if (previous === payload) return;
			const result =
				previous === undefined
					? await getClient().execute(
							'INSERT INTO integration_event_journal (shard, entry_key, payload) VALUES (?, ?, ?) IF NOT EXISTS',
							[shard, `d:${resource}`, payload],
							INTEGRATION_QUERY_OPTIONS,
						)
					: await getClient().execute(
							'UPDATE integration_event_journal SET payload = ? WHERE shard = ? AND entry_key = ? IF payload = ?',
							[payload, shard, `d:${resource}`, previous],
							INTEGRATION_QUERY_OPTIONS,
						);
			if (result.first()?.['[applied]'] === true) return;
		}
		throw new Error('Integration resource intent contention');
	}

	/** 跟踪索引保留最近资源上下文，按分片游标持续对账而非全表扫描历史 */
	async tracked(shard: number, after = 'd:', limit = 100): Promise<Array<JournalEvent>> {
		const response = await getClient().execute(
			'SELECT entry_key, payload FROM integration_event_journal WHERE shard = ? AND entry_key > ? AND entry_key < ? LIMIT ?',
			[shard, after, 'e:', limit],
			INTEGRATION_QUERY_OPTIONS,
		);
		return response.rows.map((row) => ({shard, key: String(row.entry_key), subject: '', payload: String(row.payload)}));
	}

	/** 立即完成路径复用写前记录，保留明确的删除意图 */
	async resource(resource: string): Promise<Record<string, unknown> | null> {
		const shard = createHash('sha256').update(resource).digest()[0]! % 16;
		const result = await getClient().execute(
			'SELECT payload FROM integration_event_journal WHERE shard = ? AND entry_key = ?',
			[shard, `d:${resource}`],
			INTEGRATION_QUERY_OPTIONS,
		);
		const payload = result.first()?.payload;
		if (typeof payload === 'string') return JSON.parse(payload);
		const state = await getClient().execute(
			'SELECT payload FROM integration_event_journal WHERE shard = ? AND entry_key = ?',
			[shard, `s:${resource}`],
			INTEGRATION_QUERY_OPTIONS,
		);
		const marker = state.first()?.payload;
		return typeof marker === 'string' ? JSON.parse(marker) : null;
	}

	/** 终止创建先保留失败哨兵，再清除暂态待发与跟踪，独立版本记录始终保留 */
	async failCreation(resource: string, operationId: string): Promise<void> {
		const shard = createHash('sha256').update(resource).digest()[0]! % 16;
		const intent = await this.resource(resource);
		if (intent?.creation_operation_id !== operationId) throw new Error('Creation cleanup correlation mismatch');
		await getClient().execute(
			'UPDATE integration_event_journal SET payload = ? WHERE shard = ? AND entry_key = ?',
			[JSON.stringify({creation_operation_id: operationId, creation_failed: true}), shard, `s:${resource}`],
			INTEGRATION_QUERY_OPTIONS,
		);
		await getClient().execute(
			'DELETE FROM integration_event_journal WHERE shard = ? AND entry_key >= ? AND entry_key < ?',
			[shard, `p:${resource}:`, `p:${resource};`],
			INTEGRATION_QUERY_OPTIONS,
		);
		await getClient().execute(
			'DELETE FROM integration_event_journal WHERE shard = ? AND entry_key = ?',
			[shard, `d:${resource}`],
			INTEGRATION_QUERY_OPTIONS,
		);
	}
}
