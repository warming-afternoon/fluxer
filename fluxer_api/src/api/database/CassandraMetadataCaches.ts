// SPDX-License-Identifier: AGPL-3.0-or-later

import {type ChannelID, createChannelID, createGuildID, type GuildID} from '@app/api/BrandedTypes';
import {
	CassandraMetadataInvalidation,
	type MetadataNotificationOptions,
} from '@app/api/database/CassandraMetadataInvalidation';
import {
	type MetadataInvalidation,
	renderCassandraMetadataTargetMetrics,
} from '@app/api/database/CassandraMetadataTargets';
import type {PreparedQuery} from '@app/api/database/CassandraTypes';
import {ChannelMetadataCache} from '@app/api/database/ChannelMetadataCache';
import {GuildAvailabilityCache} from '@app/api/database/GuildAvailabilityCache';
import type {ChannelRow} from '@app/api/database/types/ChannelTypes';
import type {GuildRow} from '@app/api/database/types/GuildTypes';
import {Logger} from '@app/api/Logger';
import {Channels, Guilds} from '@app/api/Tables';
import {GuildFeatures} from '@fluxer/constants/src/GuildConstants';

export interface MetadataCacheOptions {
	/** 是否启用频道元数据缓存。 */
	channelEnabled: boolean;

	/** 是否启用社区可用性缓存。 */
	guildEnabled: boolean;
}

/** 提供稳定部署命名空间和现有 Valkey 连接配置。 */
export type CassandraMetadataNotifications = Omit<MetadataNotificationOptions, 'scope'> & {
	/** 同一部署的 API 和 worker 必须使用相同标识。 */
	namespace: string;
};

/** 仅缓存真实数据库的小字段投影，不构造替代权限数据的社区或频道对象。 */
export class CassandraMetadataCaches {
	private readonly channels: ChannelMetadataCache;
	private readonly guilds: GuildAvailabilityCache;
	private readonly invalidation: CassandraMetadataInvalidation;
	private readonly counters = {
		channel_keys_invalidated: 0,
		guild_keys_invalidated: 0,
		channel_clears: 0,
		guild_clears: 0,
	};
	private lastErrorAt = Number.NEGATIVE_INFINITY;

	/** 注入数据库读取入口并绑定两个本地缓存与尽力广播。 */
	constructor(
		load: <T>(query: PreparedQuery) => Promise<Array<T>>,
		private readonly options: MetadataCacheOptions,
		keyspace: string,
		notifications: CassandraMetadataNotifications,
	) {
		this.channels = new ChannelMetadataCache(async (ids) => {
			const rows = await load<Pick<ChannelRow, 'channel_id' | 'guild_id' | 'type'>>(
				Channels.select({
					columns: ['channel_id', 'guild_id', 'type'],
					where: [Channels.where.in('channel_id', 'channel_ids'), Channels.where.eq('soft_deleted')],
				}).bind({channel_ids: ids, soft_deleted: false}),
			);
			return new Map(
				rows.map((row) => [row.channel_id, {channelId: row.channel_id, guildId: row.guild_id ?? null, type: row.type}]),
			);
		});
		this.guilds = new GuildAvailabilityCache(async (id) => {
			const [row] = await load<Pick<GuildRow, 'guild_id' | 'features'>>(
				Guilds.select({columns: ['guild_id', 'features'], where: Guilds.where.eq('guild_id')}).bind({guild_id: id}),
			);
			return row
				? {
						guildId: row.guild_id,
						unavailableForEveryone: row.features?.has(GuildFeatures.UNAVAILABLE_FOR_EVERYONE) ?? false,
						unavailableForNonStaff: row.features?.has(GuildFeatures.UNAVAILABLE_FOR_EVERYONE_BUT_STAFF) ?? false,
					}
				: null;
		});
		// 读取就绪仅依赖开关，不依赖通知连接是否健康。
		this.channels.setReady(options.channelEnabled);
		this.guilds.setReady(options.guildEnabled);
		this.invalidation = new CassandraMetadataInvalidation((change) => this.invalidate(change), {
			...notifications,
			scope: JSON.stringify([notifications.namespace, keyspace]),
			onError: (error) => {
				if (performance.now() - this.lastErrorAt < 30_000) return;
				this.lastErrorAt = performance.now();
				Logger.warn(
					{errorName: error instanceof Error ? error.name : 'UnknownError'},
					'Cassandra metadata notification failed; fixed TTL remains active',
				);
			},
		});
	}

	/** 后台启动订阅，通知连接故障不会阻断应用启动。 */
	start(): void {
		this.invalidation.start();
	}

	/** 批量取得稳定频道元数据。 */
	getChannelMetadata(ids: ReadonlyArray<ChannelID>) {
		return this.options.channelEnabled ? this.channels.getMany(ids) : null;
	}

	/** 在配置允许时读取社区可用性。 */
	getGuildAvailability(id: GuildID) {
		return this.options.guildEnabled ? this.guilds.get(id) : null;
	}

	/** 本地前后失效，不等待通知，也不改变原数据库结果。 */
	async mutate<T>(
		run: () => Promise<T>,
		changes: ReadonlyArray<MetadataInvalidation>,
		applied: (result: T) => boolean = () => true,
	): Promise<T> {
		for (const change of changes) this.invalidate(change);
		let notify = true;
		try {
			const result = await run();
			notify = applied(result);
			return result;
		} finally {
			// 数据库超时也可能已经生效，清理本地并尽力通知，绝不重试数据库写入。
			for (const change of changes) this.invalidate(change);
			if (notify) {
				try {
					this.invalidation.enqueue(changes);
				} catch {
					// 连本地通知入队也不能覆盖数据库操作的原始结果。
					Logger.warn('Cassandra metadata notification enqueue failed; fixed TTL remains active');
				}
			}
		}
	}

	/** 只清理指定实体，精确目标缺失时才清空对应类别。 */
	private invalidate(change: MetadataInvalidation): void {
		if (change.entity === 'channel') {
			if (change.ids === null) {
				this.channels.clear();
				this.counters.channel_clears += 1;
			} else {
				for (const id of change.ids) this.channels.invalidate(createChannelID(BigInt(id)));
				this.counters.channel_keys_invalidated += change.ids.length;
			}
		} else if (change.ids === null) {
			this.guilds.clear();
			this.counters.guild_clears += 1;
		} else {
			for (const id of change.ids) this.guilds.invalidate(createGuildID(BigInt(id)));
			this.counters.guild_keys_invalidated += change.ids.length;
		}
	}

	/** 仅清除两个缓存，不改变开关和通知连接状态。 */
	clear(): void {
		this.channels.clear();
		this.guilds.clear();
	}

	/** 组合两类缓存、逐键失效和通知队列的固定维度指标。 */
	renderMetrics(): string {
		return (
			this.channels.renderMetrics() +
			this.guilds.renderMetrics() +
			this.invalidation.renderMetrics() +
			renderCassandraMetadataTargetMetrics() +
			Object.entries(this.counters)
				.map(([name, value]) => `fluxer_cassandra_metadata_${name}_total ${value}\n`)
				.join('')
		);
	}

	/** 关闭本地缓存和专用通知连接。 */
	async shutdown(): Promise<void> {
		this.channels.setReady(false);
		this.guilds.setReady(false);
		await this.invalidation.shutdown();
	}
}
