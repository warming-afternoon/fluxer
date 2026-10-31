// SPDX-License-Identifier: AGPL-3.0-or-later

/** 按用户和频道合并并节流 ACK 请求。 */
export class ThrottledAckQueue {
	/** 初始化队列、并发限制和可选的自动调度器。 */
	constructor({
		send,
		queued = () => {},
		active = () => {},
		failed = () => {},
		now = () => performance.now(),
		intervalMs = 120_000,
		originMs,
		concurrency = 128,
		onAttempt = () => {},
		autoTimer = true,
		maxKeys = 100000,
	} = {}) {
		if (typeof send !== 'function') throw new TypeError('send must be a function');
		if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > 2_147_483_647)
			throw new RangeError('intervalMs must be positive');
		if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new RangeError('concurrency must be positive');
		if (!Number.isSafeInteger(maxKeys) || maxKeys < 1) throw new RangeError('maxKeys must be positive');
		this.maxKeys = maxKeys;
		this.send = send;
		// 计量回调失败不能破坏真实 ACK 调度或计数收尾。
		this.queued = (value) => {
			try {
				queued(value);
			} catch {}
		};
		this.active = (value) => {
			try {
				active(value);
			} catch {}
		};
		this.failed = (error) => {
			try {
				failed(error);
			} catch {}
		};
		this.now = now;
		this.intervalMs = intervalMs;
		this.originMs = originMs ?? now();
		this.concurrency = concurrency;
		this.onAttempt = onAttempt;
		this.autoTimer = autoTimer;
		this.keys = new Map();
		this.cursors = new Map();
		this.activeCount = 0;
		this.queuedCount = 0;
		this.closed = false;
		this.timer = null;
		this.timerDue = null;
		this.pumpScheduled = false;
		this.cancelled = false;
		this.closePromise = null;
		this.resolveClose = null;
		this.closeFailed = false;
		this.userStates = new Map();
		this.httpRequests = 0;
		this.httpFailures = 0;
	}

	/** 将同一用户和频道的新消息折叠到唯一的最新游标。 */
	enqueue(state, entry) {
		if (this.closed) throw new Error('ACK queue is closed');
		const rawUser = state?.account?.id ?? state?.userId ?? state?.id;
		const rawChannel = entry?.m?.thread?.id ?? entry?.channelId;
		for (const value of [rawUser, rawChannel, entry?.messageId]) {
			if (
				(typeof value !== 'string' && typeof value !== 'bigint' && typeof value !== 'number') ||
				(typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) ||
				!/^\d+$/.test(String(value))
			)
				throw new TypeError('ACK identities must be exact nonnegative decimal IDs');
		}
		const userId = String(rawUser);
		const channelId = String(rawChannel);
		if (!userId || !channelId || entry?.messageId == null) {
			throw new TypeError('enqueue requires userId, channelId, and messageId');
		}
		const cursor = String(entry.messageId);
		if (!/^\d+$/.test(cursor)) throw new TypeError('messageId must be a decimal snowflake');
		const key = `${userId}:${channelId}`;
		let item = this.keys.get(key);
		if (!item) {
			if (this.keys.size >= this.maxKeys) throw new RangeError('ACK key bound exceeded');
			const phase = hash(key) % this.intervalMs;
			const currentTime = this.now();
			const phaseOrigin = this.originMs + phase;
			const phaseIndex = Math.ceil((currentTime - phaseOrigin) / this.intervalMs);
			item = {
				key,
				state,
				userId,
				channelId,
				received: null,
				acknowledged: null,
				dirty: false,
				lastStarted: null,
				due: Math.max(currentTime, phaseOrigin + phaseIndex * this.intervalMs),
				version: 0,
			};
			this.keys.set(key, item);
			if (!this.userStates.has(userId)) this.userStates.set(userId, state);
		}
		item.state = state;
		if (item.received && BigInt(cursor) <= BigInt(item.received.messageId)) return;
		item.received = {...entry, messageId: cursor, channelId};
		item.version++;
		if (!item.dirty) {
			item.dirty = true;
			this.queuedCount++;
			this.queued(1);
		}
		if (this.autoTimer && !this.cancelled) this.schedule(item.due);
	}

	/** 启动当前已到时且未超过全局并发限制的请求。 */
	pump() {
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		this.timerDue = null;
		if (this.cancelled) {
			this.finishCloseIfDrained();
			return this.stats();
		}
		const currentTime = this.now();
		const ready = [...this.keys.values()]
			.filter((item) => item.dirty && !item.inFlight && item.due <= currentTime)
			.sort((left, right) => left.due - right.due || left.key.localeCompare(right.key));
		while (this.activeCount < this.concurrency && ready.length) {
			const item = ready.shift();
			const entry = item.received;
			const version = item.version;
			const queuedDue = item.due;
			item.inFlight = true;
			item.lastStarted = currentTime;
			item.due = currentTime + this.intervalMs;
			this.activeCount++;
			this.httpRequests++;
			this.active(1);
			this.emit({
				kind: 'attempt',
				userId: item.userId,
				channelId: item.channelId,
				messageId: entry.messageId,
				queuedDue,
				startedAt: currentTime,
			});
			Promise.resolve()
				.then(() => this.send(item.state, entry))
				.then(() => {
					item.acknowledged = entry;
					this.cursors.set(item.key, {
						userId: item.userId,
						channelId: item.channelId,
						messageId: entry.messageId,
					});
					if (item.version === version && item.received.messageId === entry.messageId) {
						item.dirty = false;
						this.queuedCount--;
						this.queued(-1);
					}
					this.emit({
						kind: 'complete',
						userId: item.userId,
						channelId: item.channelId,
						messageId: entry.messageId,
						succeeded: true,
						finishedAt: this.now(),
					});
				})
				.catch((error) => {
					this.httpFailures++;
					this.failed(error);
					this.closeFailed = this.closed;
					this.emit({
						kind: 'complete',
						userId: item.userId,
						channelId: item.channelId,
						messageId: entry.messageId,
						succeeded: false,
						finishedAt: this.now(),
						error,
					});
				})
				.finally(() => {
					item.inFlight = false;
					this.activeCount--;
					this.active(-1);
					if (!this.cancelled && !(this.closed && this.closeFailed)) this.pump();
					else this.finishCloseIfDrained();
				});
		}
		this.scheduleNext();
		this.finishCloseIfDrained();
		return this.stats();
	}

	/** 停止接收并等待脏键在合法时隙完成。 */
	close() {
		if (!this.closePromise) {
			this.closed = true;
			this.closePromise = new Promise((resolve) => {
				this.resolveClose = resolve;
			});
			this.pump();
		}
		return this.closePromise;
	}

	/** 取消待发请求调度并保留尚未成功的游标水位。 */
	cancel() {
		this.cancelled = true;
		this.closed = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		this.timerDue = null;
		this.finishCloseIfDrained();
		return this.stats();
	}

	/** 返回每个键的最新接收游标、成功游标及调度状态。 */
	snapshot() {
		return [...this.keys.values()].map((item) => ({
			userId: item.userId,
			channelId: item.channelId,
			received: item.received?.messageId ?? null,
			acknowledged: item.acknowledged?.messageId ?? null,
			dirty: item.dirty,
			due: item.dirty ? item.due : null,
			lastStarted: item.lastStarted,
			inFlight: Boolean(item.inFlight),
		}));
	}

	/** 返回当前脏键和活动请求数量。 */
	stats() {
		return {
			queued: this.queuedCount,
			active: this.activeCount,
			httpRequests: this.httpRequests,
			httpFailures: this.httpFailures,
			states: this.userStates.size,
			stateCount: this.userStates.size,
			drained: this.queuedCount === 0 && this.activeCount === 0,
			cancelled: this.cancelled,
			failedDuringClose: this.closeFailed,
		};
	}

	/** 更新唯一调度 timer，合并已到期投递的 pump。 */
	schedule(due) {
		if (!this.autoTimer || this.cancelled || (this.closed && this.closeFailed)) return;
		if (due <= this.now()) {
			if (!this.pumpScheduled) {
				this.pumpScheduled = true;
				queueMicrotask(() => {
					this.pumpScheduled = false;
					this.pump();
				});
			}
			return;
		}
		if (this.timer && this.timerDue <= due) return;
		if (this.timer) clearTimeout(this.timer);
		this.timerDue = due;
		this.timer = setTimeout(
			() => {
				this.timer = null;
				this.timerDue = null;
				this.pump();
			},
			Math.max(0, due - this.now()),
		);
	}

	/** 安全调用观察回调，避免观察逻辑打断 ACK 调度。 */
	emit(event) {
		try {
			this.onAttempt(event);
		} catch {}
	}

	/** 找出下一次可运行时隙并安排至多一个 timer。 */
	scheduleNext() {
		if (!this.autoTimer || this.cancelled || (this.closed && this.closeFailed) || this.activeCount >= this.concurrency)
			return;
		let earliest = Infinity;
		for (const item of this.keys.values()) {
			if (item.dirty && !item.inFlight && item.due < earliest) earliest = item.due;
		}
		if (Number.isFinite(earliest)) this.schedule(earliest);
	}

	/** 记录 drain 完成条件，并解除 close 等待。 */
	finishCloseIfDrained() {
		if (
			this.closed &&
			this.activeCount === 0 &&
			(this.queuedCount === 0 || this.cancelled || this.closeFailed) &&
			this.resolveClose
		) {
			if (this.timer) clearTimeout(this.timer);
			this.timer = null;
			this.timerDue = null;
			const resolve = this.resolveClose;
			this.resolveClose = null;
			resolve(this.stats());
		}
	}
}

/** 使用稳定字符串哈希为首次 ACK 生成错峰相位。 */
function hash(value) {
	let result = 2166136261;
	for (let index = 0; index < value.length; index++) {
		result ^= value.charCodeAt(index);
		result = Math.imul(result, 16777619);
	}
	return result >>> 0;
}
