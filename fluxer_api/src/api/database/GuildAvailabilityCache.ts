// SPDX-License-Identifier: AGPL-3.0-or-later

import type {GuildID} from '@app/api/BrandedTypes';

/** 仅表示社区可用性，不替代完整社区对象或权限判断。 */
export interface GuildAvailability {
	/** 社区标识。 */
	readonly guildId: GuildID;

	/** 是否对所有用户不可用。 */
	readonly unavailableForEveryone: boolean;

	/** 是否仅允许工作人员访问。 */
	readonly unavailableForNonStaff: boolean;
}

/** 提供可选且有界的可用性缓存，异步通知不构成线性一致的权限屏障。 */
export class GuildAvailabilityCache {
	private readonly entries = new Map<
		GuildID,
		{
			/** 已冻结的社区可用性投影。 */
			value: GuildAvailability;

			/** 从查询开始计算的过期时间。 */
			expiresAt: number;
		}
	>();
	private readonly flights = new Map<
		GuildID,
		{
			/** 同一社区的共享在途读取结果。 */
			promise: Promise<GuildAvailability | null>;

			/** 在途查询允许被合并的截止时间。 */
			expiresAt: number;
		}
	>();
	private activeFills = 0;
	private ready = false;
	private readonly counters = {hits: 0, misses: 0, joined: 0, bypassed: 0, invalidations: 0, fills: 0};

	/** 注入可用性读取入口和有界缓存配置。 */
	constructor(
		private readonly load: (id: GuildID) => Promise<GuildAvailability | null>,
		private readonly options: {
			/** 最多保存的社区数量。 */
			capacity?: number;

			/** 最多同时执行的缓存填充数量。 */
			maxFlights?: number;

			/** 从查询开始计算的有效期毫秒数。 */
			ttlMs?: number;

			/** 可注入的单调时间来源。 */
			now?: () => number;
		} = {},
	) {}

	/** 切换就绪状态并清除旧缓存和在途查询代次。 */
	setReady(ready: boolean): void {
		this.ready = ready;
		this.entries.clear();
		this.flights.clear();
	}

	/** 清空缓存和在途查询代次，但不改变就绪状态或连接。 */
	clear(): void {
		this.entries.clear();
		this.flights.clear();
	}

	/** 使指定社区及其在途查询代次失效。 */
	invalidate(id: GuildID): void {
		this.entries.delete(id);
		this.flights.delete(id);
		this.counters.invalidations += 1;
	}

	/** 读取可用性并合并同一社区的有效在途查询。 */
	async get(id: GuildID): Promise<GuildAvailability | null> {
		const now = this.options.now ?? (() => performance.now());
		const entry = this.ready ? this.entries.get(id) : undefined;
		if (entry && entry.expiresAt > now()) {
			this.entries.delete(id);
			this.entries.set(id, entry);
			this.counters.hits += 1;
			return entry.value;
		}
		this.entries.delete(id);
		// 优先复用有效在途查询，未就绪或达到并发上限时直接读取。
		const pending = this.ready ? this.flights.get(id) : undefined;
		if (pending && pending.expiresAt > now()) {
			this.counters.joined += 1;
			return pending.promise;
		}
		if (!this.ready || this.activeFills >= (this.options.maxFlights ?? 1024)) {
			this.counters.bypassed += 1;
			const value = await this.load(id);
			return value ? Object.freeze({...value}) : null;
		}
		this.counters.misses += 1;
		this.activeFills += 1;
		// 有效期从查询开始计算，避免慢旧查询延长过期状态。
		const expiresAt = now() + (this.options.ttlMs ?? 1000);
		const flight = Promise.resolve()
			.then(() => this.load(id))
			.then((row) => {
				const value = row ? Object.freeze({...row}) : null;
				if (value && this.ready && this.flights.get(id)?.promise === flight && expiresAt > now()) {
					this.entries.set(id, {value, expiresAt});
					this.counters.fills += 1;
					while (this.entries.size > (this.options.capacity ?? 10_000)) {
						this.entries.delete(this.entries.keys().next().value!);
					}
				}
				return value;
			})
			.finally(() => {
				if (this.flights.get(id)?.promise === flight) this.flights.delete(id);
				this.activeFills -= 1;
			});
		this.flights.set(id, {promise: flight, expiresAt});
		return flight;
	}

	/** 输出不含社区标识的固定维度缓存指标。 */
	renderMetrics(): string {
		return [
			...Object.entries(this.counters).map(([name, value]) => `fluxer_guild_availability_${name}_total ${value}`),
			`fluxer_guild_availability_entries ${this.entries.size}`,
			`fluxer_guild_availability_fills_inflight ${this.activeFills}`,
			`fluxer_guild_availability_ready ${Number(this.ready)}`,
			'',
		].join('\n');
	}
}
