// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ChannelID, GuildID} from '@app/api/BrandedTypes';

export interface ChannelMetadata {
	/** 频道或帖子的标识 */
	readonly channelId: ChannelID;

	/** 所属社区，私聊频道没有社区 */
	readonly guildId: GuildID | null;

	/** 频道类型，不包含权限或完整详情 */
	readonly type: number;
}

interface Entry {
	value: ChannelMetadata;

	expiresAt: number;
}

interface Flight {
	promise: Promise<ChannelMetadata | null>;

	resolve: (value: ChannelMetadata | null) => void;

	reject: (error: unknown) => void;
}

interface Options {
	capacity?: number;

	ttlMs?: number;

	maxFlights?: number;

	now?: () => number;
}

/** 缓存稳定的频道元数据，并在失效后阻止旧查询重新填充 */
export class ChannelMetadataCache {
	private readonly entries = new Map<ChannelID, Entry>();
	private readonly flights = new Map<ChannelID, Flight>();
	private activeFills = 0;
	private ready = false;
	private readonly capacity: number;
	private readonly ttlMs: number;
	private readonly maxFlights: number;
	private readonly now: () => number;
	private readonly counters = {hits: 0, misses: 0, joined: 0, bypassed: 0, invalidations: 0, fills: 0};

	/** 注入原有批量读取入口，默认采用五分钟固定有效期 */
	constructor(
		private readonly load: (ids: Array<ChannelID>) => Promise<Map<ChannelID, ChannelMetadata>>,
		options: Options = {},
	) {
		this.capacity = options.capacity ?? 50_000;
		this.ttlMs = options.ttlMs ?? 300_000;
		this.maxFlights = options.maxFlights ?? 1024;
		this.now = options.now ?? Date.now;
	}

	/** 监听恢复或断开时清空所有状态，旧查询仍可返回但不能回填 */
	setReady(ready: boolean): void {
		this.ready = ready;
		this.entries.clear();
		this.flights.clear();
	}

	/** 移除指定频道，后续请求不会加入失效前的查询 */
	invalidate(id: ChannelID): void {
		this.entries.delete(id);
		this.flights.delete(id);
		this.counters.invalidations += 1;
	}

	/** 统一单条与批量查询的缓存和并发合并行为 */
	async get(id: ChannelID): Promise<ChannelMetadata | null> {
		return (await this.getMany([id])).get(id) ?? null;
	}

	/** 批量查询只为缺失的标识访问数据库，且每次最多查询一百条 */
	async getMany(ids: ReadonlyArray<ChannelID>): Promise<Map<ChannelID, ChannelMetadata>> {
		const result = new Map<ChannelID, ChannelMetadata>();
		const waiting: Array<Promise<void>> = [];
		const fresh: Array<[ChannelID, Flight]> = [];
		const bypass: Array<ChannelID> = [];
		for (const id of new Set(ids)) {
			const cached = this.ready ? this.entries.get(id) : undefined;
			if (cached && cached.expiresAt > this.now()) {
				this.entries.delete(id);
				this.entries.set(id, cached);
				result.set(id, cached.value);
				this.counters.hits += 1;
				continue;
			}
			this.entries.delete(id);
			let flight = this.ready ? this.flights.get(id) : undefined;
			// 过期查询仍占用填充额度，但后续请求不再等待它。
			if (flight && flight.expiresAt <= this.now()) {
				this.flights.delete(id);
				flight = undefined;
			}
			if (flight) {
				this.counters.joined += 1;
			} else if (!this.ready || this.activeFills >= this.maxFlights) {
				bypass.push(id);
				this.counters.bypassed += 1;
				continue;
			} else {
				const deferred = Promise.withResolvers<ChannelMetadata | null>();
				flight = {...deferred};
				this.flights.set(id, flight);
				this.activeFills += 1;
				this.counters.misses += 1;
				fresh.push([id, flight]);
			}
			waiting.push(
				flight.promise.then((value) => {
					if (value) result.set(id, value);
				}),
			);
		}
		// 先登记所有等待者，再启动查询，确保错误始终有接收方。
		for (let offset = 0; offset < fresh.length; offset += 100) void this.fill(fresh.slice(offset, offset + 100));
		for (let offset = 0; offset < bypass.length; offset += 100) {
			waiting.push(
				this.load(bypass.slice(offset, offset + 100)).then((rows) => {
					for (const [id, value] of rows) result.set(id, value);
				}),
			);
		}
		await Promise.all(waiting);
		return result;
	}

	/** 仅当前仍登记的查询可以写入缓存，不保存失败或不存在的记录 */
	private async fill(batch: Array<[ChannelID, Flight]>): Promise<void> {
		try {
			const rows = await this.load(batch.map(([id]) => id));
			for (const [id, flight] of batch) {
				const row = rows.get(id);
				const value = row ? Object.freeze({...row}) : null;
				if (this.ready && this.flights.get(id) === flight && value) {
					this.entries.delete(id);
					this.entries.set(id, {value, expiresAt: this.now() + this.ttlMs});
					this.counters.fills += 1;
					while (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value!);
				}
				flight.resolve(value);
			}
		} catch (error) {
			for (const [, flight] of batch) flight.reject(error);
		} finally {
			for (const [id, flight] of batch) {
				if (this.flights.get(id) === flight) this.flights.delete(id);
				this.activeFills -= 1;
			}
		}
	}

	/** 输出固定维度指标，不暴露频道或用户标识 */
	renderMetrics(): string {
		return [
			...Object.entries(this.counters).map(([name, value]) => `fluxer_channel_metadata_${name}_total ${value}`),
			`fluxer_channel_metadata_entries ${this.entries.size}`,
			`fluxer_channel_metadata_fills_inflight ${this.activeFills}`,
			`fluxer_channel_metadata_ready ${Number(this.ready)}`,
			'',
		].join('\n');
	}
}
