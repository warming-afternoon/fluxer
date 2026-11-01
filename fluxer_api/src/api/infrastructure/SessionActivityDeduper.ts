// SPDX-License-Identifier: AGPL-3.0-or-later

/** 只记住已成功入队的会话活动期限，不参与身份或撤销判定。 */
export class SessionActivityDeduper {
	private readonly successful = new Map<string, number>();
	private readonly flights = new Map<string, Promise<boolean>>();
	private generation = 0;
	readonly counters = {hits: 0, joined: 0, writes: 0, failures: 0};

	/** 成功期限比共享五分钟键早一秒到期，缓存最多两万项。 */
	constructor(
		private readonly capacity = 20000,
		private readonly now = () => performance.now(),
	) {}

	/** 合并同会话在途操作，仅首次成功请求返回已写入。 */
	async run(key: string, write: () => Promise<boolean>): Promise<boolean> {
		const now = this.now();
		const deadline = this.successful.get(key);
		if (deadline !== undefined && deadline > now) {
			this.counters.hits++;
			return false;
		}
		this.successful.delete(key);
		const existing = this.flights.get(key);
		if (existing) {
			await existing;
			this.counters.joined++;
			return false;
		}
		const generation = this.generation;
		const flight = Promise.resolve()
			.then(write)
			.then((applied) => {
				if (applied && generation === this.generation) {
					this.successful.set(key, now + 299000);
					while (this.successful.size > this.capacity) this.successful.delete(this.successful.keys().next().value!);
					this.counters.writes++;
				}
				return applied;
			})
			.catch((error: unknown) => {
				this.counters.failures++;
				throw error;
			})
			.finally(() => {
				if (this.flights.get(key) === flight) this.flights.delete(key);
			});
		this.flights.set(key, flight);
		return flight;
	}

	/** 撤销使在途旧操作不能重新填充本地成功期限。 */
	forget(keys: ReadonlyArray<string>): void {
		this.generation++;
		for (const key of keys) {
			this.successful.delete(key);
			this.flights.delete(key);
		}
	}

	/** 输出固定维度计数，无会话标识。 */
	renderMetrics(): string {
		return [
			...Object.entries(this.counters).map(([name, n]) => `fluxer_session_activity_${name}_total ${n}`),
			`fluxer_session_activity_entries ${this.successful.size}`,
			'',
		].join('\n');
	}
}
