// SPDX-License-Identifier: AGPL-3.0-or-later

/** 按真实前端的首次期限与最新频道游标合并确认，保留全部消息覆盖证据。 */
export class FrontendAckQueue {
	/** 注入请求、计数与时钟，使离线测试不需要真实服务。 */
	constructor({
		send,
		covered,
		queued,
		active,
		failed,
		started = () => {},
		now = () => performance.now(),
		concurrency = 128,
	}) {
		Object.assign(this, {send, covered, queued, active, failed, started, now, concurrency});
		this.users = new Map();
		this.userOrder = [];
		this.nextUser = 0;
		this.cursors = new Map();
		this.running = 0;
		this.closed = false;
		this.stats = {httpRequests: 0, httpFailures: 0, retries: 0, entriesSubmitted: 0, coveredMessages: 0};
		this.timer = setInterval(() => this.pump(), 10);
	}

	/** 自动阅读无提及消息采用三秒延迟，显式立即确认保留零延迟分支。 */
	enqueue(user, job, {immediate = false, hadMentions = false} = {}) {
		if (this.closed) throw Error('ACK queue is closed');
		let state = this.users.get(user.account.id);
		if (!state) {
			state = {user, entries: new Map(), busy: false};
			this.users.set(user.account.id, state);
			this.userOrder.push(state);
		}
		const channel = String(job.m.thread.id);
		const deadline = this.now() + (immediate || hadMentions ? 0 : 3000);
		let entry = state.entries.get(channel);
		if (!entry) {
			entry = {channel, messageId: job.messageId, deadline, attempt: 0, jobs: []};
			state.entries.set(channel, entry);
		}
		entry.deadline = Math.min(entry.deadline, deadline);
		if (BigInt(job.messageId) > BigInt(entry.messageId)) entry.messageId = job.messageId;
		entry.jobs.push(job);
		this.queued(1);
		if (immediate || hadMentions) this.pump();
	}

	/** 每用户串行、全局限流发送到期频道，批次最多一百个频道。 */
	pump() {
		if (this.closed) return;
		// 从上次授予槽位之后继续扫描，每次最多检查一轮用户。
		let remaining = this.userOrder.length;
		while (remaining-- > 0 && this.running < this.concurrency) {
			if (this.nextUser >= this.userOrder.length) this.nextUser = 0;
			const state = this.userOrder[this.nextUser++];
			if (state.busy) continue;
			const entries = [...state.entries.values()].filter((entry) => entry.deadline <= this.now()).slice(0, 100);
			if (!entries.length) continue;
			const snapshots = entries.map((entry) => ({...entry, jobs: [...entry.jobs]}));
			state.busy = true;
			this.running++;
			this.active(1);
			void this.flush(state, snapshots)
				.catch((error) => {
					this.close();
					this.failed(error);
				})
				.finally(() => {
					state.busy = false;
					this.running--;
					this.active(-1);
					this.pump();
				});
		}
	}

	/** 只在服务器权威游标覆盖整个快照后计入成功，失败沿用前端指数退避。 */
	async flush(state, snapshots) {
		this.stats.httpRequests++;
		this.stats.entriesSubmitted += snapshots.length;
		for (const entry of snapshots) for (const job of entry.jobs) this.started(job);
		const result = await this.send(
			state.user,
			snapshots.map((entry) => ({channel_id: entry.channel, message_id: entry.messageId})),
		);
		if (result.status !== 200) {
			this.stats.httpFailures++;
			for (const sent of snapshots) {
				const current = state.entries.get(sent.channel);
				if (current.messageId !== sent.messageId) continue;
				current.attempt++;
				current.deadline = this.now() + Math.min(60000, 5000 * 2 ** (current.attempt - 1));
				this.stats.retries++;
			}
			return;
		}
		// 响应必须覆盖所有请求频道，不能用状态码替代已读状态验证。
		const returned = new Map((result.data?.read_states ?? []).map((row) => [String(row.id), row.last_message_id]));
		for (const sent of snapshots) {
			const cursor = returned.get(sent.channel);
			if (!cursor || BigInt(cursor) < BigInt(sent.messageId))
				throw Error('Authoritative ACK cursor did not cover submitted messages');
		}
		for (const sent of snapshots) {
			const current = state.entries.get(sent.channel);
			const done = new Set(sent.jobs);
			current.jobs = current.jobs.filter((job) => !done.has(job));
			if (!current.jobs.length) state.entries.delete(sent.channel);
			const key = `${state.user.account.id}:${sent.channel}`;
			const prior = this.cursors.get(key);
			if (!prior || BigInt(prior.messageId) < BigInt(sent.messageId)) {
				this.cursors.set(key, {userId: state.user.account.id, channelId: sent.channel, messageId: sent.messageId});
			}
			for (const job of sent.jobs) this.covered(state.user, job);
			this.stats.coveredMessages += sent.jobs.length;
			this.queued(-sent.jobs.length);
		}
	}

	/** 停止定时器，退出时仍由调用者等待已开始的HTTP请求结束。 */
	close() {
		this.closed = true;
		clearInterval(this.timer);
	}
}
