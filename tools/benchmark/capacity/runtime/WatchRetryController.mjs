// SPDX-License-Identifier: AGPL-3.0-or-later

/** 将重试绑定到 watch nonce 和周期，迟到 ACK 必须取消尚未执行的旧重试。 */
export class WatchRetryController {
	/** 注入 timer，允许用离线时钟复验竞争而不连接服务。 */
	constructor({setTimer = setTimeout, clearTimer = clearTimeout} = {}) {
		this.setTimer = setTimer;
		this.clearTimer = clearTimer;
		this.timer = null;
		this.current = null;
		this.generation = 0;
		this.closed = false;
	}

	/** 新请求替换旧周期，清除旧 timer 并使已入队回调失效。 */
	begin({nonce, cycle}) {
		if (this.closed) throw new Error('Watch retry controller closed');
		if (typeof nonce !== 'string' || !nonce || !Number.isSafeInteger(cycle) || cycle < 0)
			throw new TypeError('Invalid watch request identity');
		if (this.timer !== null) this.clearTimer(this.timer);
		this.timer = null;
		this.current = {nonce, cycle, acknowledged: false};
		this.generation++;
	}

	/** 仅当前周期可安排重试；执行前再次检查 ACK 和世代，避免回调取消竞争。 */
	schedule(delayMs, retry) {
		if (this.closed || !this.current || this.current.acknowledged) return false;
		if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 2_147_483_647 || typeof retry !== 'function')
			throw new TypeError('Invalid retry schedule');
		if (this.timer !== null) this.clearTimer(this.timer);
		const generation = ++this.generation;
		const request = this.current;
		this.timer = this.setTimer(() => {
			if (this.closed || this.current !== request || this.generation !== generation || request.acknowledged) return;
			this.timer = null;
			retry({nonce: request.nonce, cycle: request.cycle});
		}, delayMs);
		return true;
	}

	/** ACK 只匹配原 nonce 与周期，旧连接 ACK 不取消新请求。 */
	acknowledge({nonce, cycle}) {
		if (this.closed || !this.current || this.current.nonce !== nonce || this.current.cycle !== cycle) return false;
		this.current.acknowledged = true;
		this.generation++;
		if (this.timer !== null) this.clearTimer(this.timer);
		this.timer = null;
		return true;
	}

	/** 关闭后所有已排队回调都失效，不发送最后一次隐式续租。 */
	close() {
		this.closed = true;
		this.generation++;
		if (this.timer !== null) this.clearTimer(this.timer);
		this.timer = null;
		this.current = null;
	}
}
