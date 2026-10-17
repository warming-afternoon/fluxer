// SPDX-License-Identifier: AGPL-3.0-or-later

import type {Channel} from '@app/features/channel/models/Channel';
import GatewaySessions from '@app/features/gateway/transport/GatewaySessionPool';
import {deferUntilModulesLoaded} from '@app/features/platform/utils/DeferUntilModulesLoaded';
import ThreadGuilds from '@app/features/threads/state/ThreadGuilds';
import {compareStructural, makeAutoObservable, reaction, runInAction} from 'mobx';

interface WatchReference {
	// 帖子所属服务器
	guildId: string;

	// 实际显示该帖子的组件数量
	count: number;

	// 每次重新进入帖子的独立代次
	generation: number;
}

export interface ThreadWatchAck {
	// 对应当前连接请求的标识
	nonce: string;

	// 是否处理成功
	ok: boolean;

	// 确认所属服务器，全局额度错误时缺省
	guild_id?: string;

	// 服务端接受的帖子集合
	thread_ids?: Array<string>;

	// 租约首次建立或失效后需要刷新的帖子
	resync_thread_ids?: Array<string>;

	// 服务端租约到期时间
	expires_at?: number;

	// 明确的失败原因
	code?: string;
}

interface WatchRequest {
	// 本次请求标识
	nonce: string;

	// 本次发送的各服务器完整集合
	groups: Map<string, Array<string>>;

	// 尚未收到确认的服务器
	waiting: Set<string>;

	// 超限后只续期服务端已经接受的集合
	acceptedOnly: boolean;
}

class ThreadWatches {
	private references = new Map<string, WatchReference>();
	private sentGuilds = new Set<string>();
	private pending: WatchRequest | null = null;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private ackTimer: ReturnType<typeof setTimeout> | null = null;
	private leaseTimer: ReturnType<typeof setTimeout> | null = null;
	private leaseExpirations = new Map<string, number>();
	private limited = false;
	private armed = false;
	private epoch = 0;
	private serial = 0;
	private lastSentAt = 0;
	private sentKey = '';
	private recovering = new Map<string, string>();
	private messageCommands: Promise<typeof import('@app/features/messaging/commands/MessageCommands')> | null = null;
	private referenceSerial = 0;
	confirmed = new Set<string>();
	errors = new Map<string, 'limit' | 'unavailable' | 'expired'>();

	/** 观察实际显示的帖子，后台页面保持相同浏览集合 */
	constructor() {
		makeAutoObservable<
			this,
			| 'sentGuilds'
			| 'pending'
			| 'timer'
			| 'ackTimer'
			| 'leaseTimer'
			| 'leaseExpirations'
			| 'limited'
			| 'recovering'
			| 'messageCommands'
		>(
			this,
			{
				sentGuilds: false,
				pending: false,
				timer: false,
				ackTimer: false,
				leaseTimer: false,
				leaseExpirations: false,
				limited: false,
				recovering: false,
				messageCommands: false,
			},
			{autoBind: true},
		);
		deferUntilModulesLoaded(() => {
			reaction(
				() => ({
					epoch: this.epoch,
					armed: this.armed,
					groups: [...this.references]
						.filter(([, ref]) => ThreadGuilds.isActive(ref.guildId))
						.map(([id, ref]) => [ref.guildId, id, ref.generation])
						.sort(),
				}),
				() => this.send(false),
				{equals: compareStructural, scheduler: (run) => queueMicrotask(run)},
			);
			if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.handleResume);
			if (typeof window !== 'undefined') window.addEventListener('pageshow', this.handleResume);
		});
	}

	/** 按实际界面引用计数，列表预加载不调用此方法 */
	retain(thread: Pick<Channel, 'id' | 'guildId'>): () => void {
		const guildId = thread.guildId;
		if (!guildId) return () => {};
		const previous = this.references.get(thread.id);
		this.references.set(thread.id, {
			guildId,
			count: (previous?.count ?? 0) + 1,
			generation: previous?.generation ?? ++this.referenceSerial,
		});
		let released = false;
		return () =>
			runInAction(() => {
				if (released) return;
				released = true;
				const current = this.references.get(thread.id);
				if (!current || current.count <= 1) {
					this.references.delete(thread.id);
					this.confirmed.delete(thread.id);
					this.errors.delete(thread.id);
					this.leaseExpirations.delete(thread.id);
					this.scheduleLeaseExpiry();
				} else this.references.set(thread.id, {...current, count: current.count - 1});
			});
	}

	/** 新连接和成功恢复都重新确认浏览关系 */
	handleConnectionReady(): void {
		this.clearTimers();
		this.confirmed.clear();
		this.pending = null;
		this.sentKey = '';
		this.limited = false;
		this.armed = true;
		this.epoch += 1;
		this.scheduleLeaseExpiry();
	}

	/** 连接不可用时停止续期请求，保留浏览意愿及独立到期提示 */
	handleConnectionLost(): void {
		this.clearTimers();
		this.armed = false;
		this.confirmed.clear();
		this.pending = null;
		// 保留曾经发送的服务器集合，恢复后才能立即取消离线期间关闭的帖子
		this.sentKey = '';
	}

	/** 合并同一批界面变化，一次发送跨服务器完整目标集合 */
	private send(force: boolean): void {
		const socket = GatewaySessions.foregroundConnection.socket;
		if (!this.armed || !socket?.isConnected()) return;
		this.scheduleLeaseExpiry();
		const groups = new Map<string, Array<string>>();
		for (const [id, ref] of this.references) {
			if (!ThreadGuilds.isActive(ref.guildId)) continue;
			const ids = groups.get(ref.guildId) ?? [];
			ids.push(id);
			groups.set(ref.guildId, ids);
		}
		const key = JSON.stringify(
			[...groups]
				.map(([guild, ids]) => [guild, ids.sort().map((id) => [id, this.references.get(id)?.generation])])
				.sort(),
		);
		if (!force && key === this.sentKey) return;
		// 阅读集合变化后重新争取空出的额度，常规重试只续期已接受的帖子
		if (!force) this.limited = false;
		if (this.limited) {
			for (const [guildId, ids] of groups) {
				const accepted = ids.filter((id) => this.leaseExpirations.has(id));
				if (accepted.length > 0) groups.set(guildId, accepted);
				else groups.delete(guildId);
			}
		}
		for (const guildId of this.sentGuilds) {
			if (!ThreadGuilds.isActive(guildId)) this.sentGuilds.delete(guildId);
			else if (!groups.has(guildId)) groups.set(guildId, []);
		}
		if (groups.size === 0) return;
		this.clearTimers();
		const nonce = `${this.epoch}:${++this.serial}`;
		this.pending = {nonce, groups, waiting: new Set(groups.keys()), acceptedOnly: this.limited};
		this.sentKey = key;
		this.lastSentAt = Date.now();
		this.sentGuilds = new Set(groups.keys());
		socket.updateGuildSubscriptions({
			thread_watch_nonce: nonce,
			subscriptions: Object.fromEntries([...groups].map(([guild, ids]) => [guild, {thread_watches: ids}])),
		});
		// 缺少确认时显式显示失败并重试，不能假装已有实时订阅
		this.ackTimer = setTimeout(
			() =>
				runInAction(() => {
					if (this.pending?.nonce !== nonce) return;
					for (const guildId of this.pending.waiting) {
						for (const id of groups.get(guildId) ?? []) {
							if (this.errors.get(id) !== 'expired') this.errors.set(id, 'unavailable');
						}
					}
					this.send(true);
				}),
			10_000,
		);
	}

	/** 只接受当前请求确认，正常续期不再次拉取历史 */
	handleAck(data: ThreadWatchAck): void {
		const pending = this.pending;
		if (!pending || data.nonce !== pending.nonce) return;
		this.scheduleLeaseExpiry();
		if (!data.ok) {
			for (const ids of pending.groups.values())
				for (const id of ids) {
					if (data.code === 'THREAD_WATCH_LIMIT_EXCEEDED' && this.confirmed.has(id)) continue;
					if (this.errors.get(id) === 'expired') continue;
					this.errors.set(id, data.code === 'THREAD_WATCH_LIMIT_EXCEEDED' ? 'limit' : 'unavailable');
				}
			this.clearTimers();
			this.pending = null;
			if (data.code === 'THREAD_WATCH_LIMIT_EXCEEDED' && !pending.acceptedOnly) {
				this.limited = true;
				this.send(true);
				return;
			}
			this.timer = setTimeout(() => this.send(true), 30_000);
			return;
		}
		const guildId = data.guild_id;
		if (!guildId || !pending.waiting.delete(guildId)) return;
		const accepted = new Set(data.thread_ids ?? []);
		const resync = new Set(data.resync_thread_ids ?? []);
		for (const id of pending.groups.get(guildId) ?? []) {
			if (!this.references.has(id)) continue;
			if (!accepted.has(id)) {
				this.confirmed.delete(id);
				this.leaseExpirations.delete(id);
				this.errors.set(id, 'unavailable');
				continue;
			}
			// 只承认尚未到期的服务端租约，迟到回包不能恢复实时可用状态
			const expiresAt = data.expires_at;
			if (expiresAt == null || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
				this.confirmed.delete(id);
				this.errors.set(id, expiresAt != null && expiresAt <= Date.now() ? 'expired' : 'unavailable');
				continue;
			}
			const needsRefresh = !this.confirmed.has(id) || resync.has(id);
			this.leaseExpirations.set(id, expiresAt);
			this.confirmed.add(id);
			this.errors.delete(id);
			if (needsRefresh) void this.refresh(id);
		}
		this.scheduleLeaseExpiry();
		if ((pending.groups.get(guildId)?.length ?? 0) === 0) this.sentGuilds.delete(guildId);
		if (pending.waiting.size === 0) {
			this.clearTimers();
			this.pending = null;
			if (this.references.size > 0)
				this.timer = setTimeout(
					() => this.send(true),
					[...this.errors.values()].some((error) => error !== 'limit')
						? 30_000
						: 240_000 + Math.random() * 30_000 - 15_000,
				);
		}
	}

	/** 订阅确认后的窗口恢复与普通续期分离 */
	private async refresh(threadId: string): Promise<void> {
		const epoch = this.epoch;
		const generation = this.references.get(threadId)?.generation;
		const key = `${epoch}:${generation}`;
		if (this.recovering.get(threadId) === key) return;
		this.recovering.set(threadId, key);
		const isCurrent = () =>
			this.armed && this.epoch === epoch && this.references.get(threadId)?.generation === generation;
		try {
			// 多个帖子同时确认时共享模块加载，避免重复初始化同一恢复入口
			const {refreshThreadWatchWindow} = await (this.messageCommands ??= import(
				'@app/features/messaging/commands/MessageCommands'
			).catch((error: unknown) => {
				this.messageCommands = null;
				throw error;
			}));
			if (isCurrent()) await refreshThreadWatchWindow(threadId, isCurrent);
		} catch {
			runInAction(() => {
				if (isCurrent()) {
					this.scheduleLeaseExpiry();
					if (this.errors.get(threadId) !== 'expired') this.errors.set(threadId, 'unavailable');
					this.confirmed.delete(threadId);
					if (this.timer !== null) clearTimeout(this.timer);
					this.timer = setTimeout(() => this.send(true), 30_000);
				}
			});
		} finally {
			if (this.recovering.get(threadId) === key) this.recovering.delete(threadId);
		}
	}

	/** 休眠恢复后立即重申租约，后台本身不会退订 */
	private handleResume(): void {
		this.scheduleLeaseExpiry();
		if (document.visibilityState === 'visible' && Date.now() - this.lastSentAt >= 225_000) this.send(true);
	}

	/** 独立跟踪服务端期限，续期重试不能延长本地确认状态 */
	private scheduleLeaseExpiry(): void {
		if (this.leaseTimer !== null) clearTimeout(this.leaseTimer);
		this.leaseTimer = null;
		const now = Date.now();
		let nextExpiry = Number.POSITIVE_INFINITY;
		for (const [id, expiresAt] of this.leaseExpirations) {
			if (!this.references.has(id)) {
				this.leaseExpirations.delete(id);
				continue;
			}
			if (expiresAt <= now) {
				this.confirmed.delete(id);
				this.errors.set(id, 'expired');
			} else nextExpiry = Math.min(nextExpiry, expiresAt);
		}
		if (Number.isFinite(nextExpiry)) {
			this.leaseTimer = setTimeout(this.scheduleLeaseExpiry, nextExpiry - now);
		}
	}

	/** 清理续期请求定时器，租约期限仍由独立定时器跟踪 */
	private clearTimers(): void {
		if (this.timer !== null) clearTimeout(this.timer);
		if (this.ackTimer !== null) clearTimeout(this.ackTimer);
		this.timer = null;
		this.ackTimer = null;
	}
}

export default new ThreadWatches();
