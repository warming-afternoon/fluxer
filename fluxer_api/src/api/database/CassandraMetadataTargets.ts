// SPDX-License-Identifier: AGPL-3.0-or-later

import {getKvMeta} from '@app/api/database/CassandraMetaRegistry';
import type {CassandraParams, KvQueryMeta} from '@app/api/database/CassandraTypes';
import {getStatementMeta} from '@app/api/database/CassandraTypes';

/** 表达一类元数据的精确失效，空标识列表不产生失效。 */
export interface MetadataInvalidation {
	/** 需要清理的缓存类别。 */
	entity: 'channel' | 'guild';

	/** 需要清理的标识；null 表示清空该类别。 */
	ids: ReadonlyArray<string> | null;
}

const fallbackCounters = {channel: 0, guild: 0, unknown: 0};

/** 记录无法提取精确目标的回退，不记录实体标识。 */
function fallbackInvalidation(entity?: MetadataInvalidation['entity']): Array<MetadataInvalidation> {
	fallbackCounters[entity ?? 'unknown'] += 1;
	return entity
		? [{entity, ids: null}]
		: [
				{entity: 'channel', ids: null},
				{entity: 'guild', ids: null},
			];
}

/** 输出目标识别回退指标，与正常清表和通知断线清理区分。 */
export function renderCassandraMetadataTargetMetrics(): string {
	return Object.entries(fallbackCounters)
		.map(([entity, count]) => `fluxer_cassandra_metadata_target_${entity}_fallback_total ${count}\n`)
		.join('');
}

/** 校验标识而不将大整数转换为 JavaScript 数值。 */
function metadataId(value: unknown): string | null {
	if (typeof value !== 'bigint' && typeof value !== 'string') return null;
	const id = String(value);
	return /^[1-9]\d{0,19}$/.test(id) ? id : null;
}

/** 合并批次目标，并让类别清空覆盖同类别逐键通知。 */
export function mergeMetadataInvalidations(changes: ReadonlyArray<MetadataInvalidation>): Array<MetadataInvalidation> {
	const grouped = new Map<MetadataInvalidation['entity'], Set<string> | null>();
	for (const change of changes) {
		if (grouped.has(change.entity) && grouped.get(change.entity) === null) continue;
		if (change.ids === null) grouped.set(change.entity, null);
		else {
			const ids = grouped.get(change.entity) ?? new Set<string>();
			for (const id of change.ids) ids.add(id);
			if (ids.size) grouped.set(change.entity, ids);
		}
	}
	return [...grouped].map(([entity, ids]) => ({entity, ids: ids === null ? null : [...ids]}));
}

/** 从数据库访问层的元数据提取失效目标，未知写入保守扩大范围。 */
export function getCassandraMetadataInvalidations(
	cql: string,
	params: CassandraParams,
	meta: KvQueryMeta | undefined = getKvMeta(cql),
): Array<MetadataInvalidation> {
	if (getStatementMeta(cql).type === 'SELECT') return [];
	if (!meta) {
		// 原始 CQL 不猜测字段绑定关系，但可以安全识别常见语句的目标表。
		const match =
			/^\s*(?:INSERT\s+INTO|UPDATE|DELETE[\s\S]*?\sFROM|TRUNCATE(?:\s+TABLE)?)\s+(?:[a-z_][\w]*\.)?([a-z_][\w]*)\b/i.exec(
				cql,
			);
		if (match) {
			const table = match[1]!.toLowerCase();
			if (table !== 'channels' && table !== 'guilds') return [];
			const entity = table === 'channels' ? 'channel' : 'guild';
			return /^\s*TRUNCATE\b/i.test(cql) ? [{entity, ids: null}] : fallbackInvalidation(entity);
		}
		return fallbackInvalidation();
	}
	if (meta.action === 'select' || meta.action === 'count') return [];
	const table = meta.table.name;
	if (table !== 'channels' && table !== 'guilds') return [];
	const entity = table === 'channels' ? 'channel' : 'guild';
	const column = table === 'channels' ? 'channel_id' : 'guild_id';
	if (meta.action === 'batch') {
		if (!meta.batchEntries?.length) return fallbackInvalidation(entity);
		return mergeMetadataInvalidations(
			meta.batchEntries.flatMap((entry) => {
				const bindings = entry.pk.filter((key) => key.col === column);
				const changes = entry.action === 'patch' ? entry.patch.map((key) => key.col) : undefined;
				const nested: KvQueryMeta = {
					action: entry.action,
					table: meta.table,
					where: bindings.map((key) => ({kind: 'eq' as const, col: key.col, param: key.param})),
					patchKeys: changes,
					ttlParamName: 'ttlParamName' in entry ? entry.ttlParamName : undefined,
				};
				return getCassandraMetadataInvalidations(cql, params, nested);
			}),
		);
	}
	if (meta.action === 'patch') {
		const fields = meta.patchKeys ?? Object.keys(meta.patch ?? {});
		const relevant =
			entity === 'channel' ? ['channel_id', 'guild_id', 'type', 'soft_deleted'] : ['guild_id', 'features'];
		if (
			fields.length &&
			meta.ttlSeconds === undefined &&
			meta.ttlParamName === undefined &&
			!fields.some((field) => relevant.includes(field))
		)
			return [];
	}
	const ids = new Set<string>();
	const predicates = meta.where?.filter((where) => where.col === column) ?? [];
	if (predicates.length) {
		for (const where of predicates) {
			if (where.kind !== 'eq' && where.kind !== 'in') return fallbackInvalidation(entity);
			const bound = params[where.param];
			const values = where.kind === 'in' ? (Array.isArray(bound) ? bound : null) : [bound];
			if (!values) return fallbackInvalidation(entity);
			for (const value of values) {
				const id = metadataId(value);
				if (!id) return fallbackInvalidation(entity);
				ids.add(id);
			}
		}
	} else {
		const id = metadataId(params[column]);
		if (!id) return fallbackInvalidation(entity);
		ids.add(id);
	}
	// 显式标识补丁存在时，同时清理旧对象和新对象。
	const patch = meta.patch?.[column];
	if (patch) {
		const id = patch.kind === 'set' ? metadataId(patch.value) : null;
		if (!id) return fallbackInvalidation(entity);
		ids.add(id);
	}
	return [{entity, ids: [...ids]}];
}
