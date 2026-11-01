// SPDX-License-Identifier: AGPL-3.0-or-later

import {createHash, randomUUID} from 'node:crypto';
import type {MetadataInvalidation} from '@app/api/database/CassandraMetadataTargets';
import {KVClient} from '@pkgs/kv_client/src/KVClient';
import type {KVClientConfig} from '@pkgs/kv_client/src/KVClientConfig';
import {KVSubscription} from '@pkgs/kv_client/src/KVSubscription';

/** 注入通知连接，测试不依赖真实网络。 */
export interface MetadataNotificationConnections {
	/** 发布有大小限制的失效通知。 */
	publish(channel: string, message: string): Promise<unknown>;

	/** 建立订阅并向调用方报告状态和消息。 */
	connect(channel: string, message: (value: string) => void, state: (ready: boolean) => void): Promise<void>;

	/** 立即关闭发布和订阅连接。 */
	close(): void;
}

/** 提供进程隔离、连接配置和可替换的通知传输。 */
export interface MetadataNotificationOptions {
	/** 部署命名空间与数据库 keyspace 的稳定组合。 */
	scope: string;

	/** 复用既有 Valkey 部署，不保存缓存值。 */
	kv: Pick<KVClientConfig, 'url' | 'mode'>;

	/** 仅记录固定维度错误，不输出实体标识。 */
	onError?: (error: unknown) => void;

	/** 测试可注入有界传输，生产使用两个专用连接。 */
	connections?: MetadataNotificationConnections;
}

const COMMAND_TIMEOUT_MS = 250;
const MAX_PENDING_KEYS = 1024;
const MAX_BATCH_IDS = 100;
const MAX_NOTICE_BYTES = 16 * 1024;

/** 通过有界 Valkey 广播尽力失效，遗漏由本地固定有效期兜底。 */
export class CassandraMetadataInvalidation {
	private readonly channel: string;
	private readonly origin = randomUUID();
	private readonly pending = new Map<MetadataInvalidation['entity'], Set<string> | null>();
	private readonly counters = {published: 0, received: 0, failures: 0, malformed: 0, coalesced: 0, overflow: 0};
	private connections: MetadataNotificationConnections | null = null;
	private active: Promise<void> | null = null;
	private scheduled = false;
	private started = false;
	private stopped = false;
	private subscribed = false;
	private retry: ReturnType<typeof setTimeout> | null = null;
	private retryDelayMs = 500;

	/** 注入本地失效入口，通知命名空间不包含凭据。 */
	constructor(
		private readonly apply: (change: MetadataInvalidation) => void,
		private readonly options: MetadataNotificationOptions,
	) {
		const scope = createHash('sha256').update(options.scope).digest('hex').slice(0, 24);
		this.channel = `fluxer:ca:metadata:v2:${scope}`;
	}

	/** 后台连接订阅，连接失败不阻止应用启动或使用 TTL 缓存。 */
	start(): void {
		if (this.started || this.stopped) return;
		this.started = true;
		try {
			this.connections = this.options.connections ?? this.createConnections();
			void this.connect();
		} catch (error) {
			this.reportFailure(error);
		}
	}

	/** 只为元数据通知创建短超时连接，不影响既有 KV 客户端配置。 */
	private createConnections(): MetadataNotificationConnections {
		const publisher = new KVClient({...this.options.kv, timeoutMs: COMMAND_TIMEOUT_MS, enableOfflineQueue: false});
		let subscriber: KVSubscription | null = null;
		return {
			publish: (channel, message) => publisher.publish(channel, message),
			connect: async (channel, message, state) => {
				// 初始连接失败后重新创建订阅；已就绪连接由客户端自动重连。
				await subscriber?.disconnect();
				subscriber = new KVSubscription({
					...this.options.kv,
					timeoutMs: COMMAND_TIMEOUT_MS,
					logger: {debug() {}, error() {}},
					onStateChange: state,
				});
				subscriber.on('message', (receivedChannel, value) => {
					if (receivedChannel === channel) message(value);
				});
				subscriber.on('error', (error) => {
					this.subscribed = false;
					this.clearLocal();
					this.reportFailure(error);
				});
				await subscriber.subscribe(channel);
				await subscriber.connect();
			},
			close: () => {
				publisher.close();
				void subscriber?.disconnect();
			},
		};
	}

	/** 订阅初始失败采用有上限的退避，运行期间缓存仍可使用。 */
	private async connect(): Promise<void> {
		if (this.stopped || !this.connections) return;
		try {
			await this.connections.connect(
				this.channel,
				(value) => this.receive(value),
				(ready) => {
					if (this.stopped) return;
					this.subscribed = ready;
					// 重连和断开均清空旧条目，但不禁用下一次 TTL 填充。
					this.clearLocal();
				},
			);
			if (!this.stopped) this.retryDelayMs = 500;
		} catch (error) {
			if (this.stopped) return;
			this.subscribed = false;
			this.clearLocal();
			this.reportFailure(error);
			this.retry = setTimeout(() => {
				this.retry = null;
				void this.connect();
			}, this.retryDelayMs);
			this.retry.unref();
			this.retryDelayMs = Math.min(this.retryDelayMs * 2, 5000);
		}
	}

	/** 合并失效目标，溢出时升级为类别清空，始终保持有限积压。 */
	enqueue(changes: ReadonlyArray<MetadataInvalidation>): void {
		if (this.stopped || !this.connections) return;
		for (const change of changes) {
			if (this.pending.has(change.entity) && this.pending.get(change.entity) === null) {
				this.counters.coalesced += 1;
				continue;
			}
			if (change.ids === null) this.pending.set(change.entity, null);
			else {
				const ids = this.pending.get(change.entity) ?? new Set<string>();
				for (const id of change.ids) {
					if (ids.has(id)) this.counters.coalesced += 1;
					ids.add(id);
					this.pending.set(change.entity, ids);
					if (this.pendingKeys() > MAX_PENDING_KEYS) {
						this.pending.set(change.entity, null);
						this.counters.overflow += 1;
						break;
					}
				}
			}
		}
		if (!this.active && !this.scheduled) {
			this.scheduled = true;
			queueMicrotask(() => {
				this.scheduled = false;
				this.pump();
			});
		}
	}

	/** 每次只发布一个批次，失败不重试该批，也不进入数据库请求链。 */
	private pump(): void {
		if (this.stopped || this.active || !this.connections) return;
		const first = this.pending.entries().next().value;
		if (!first) return;
		const [entity, pending] = first;
		const ids = pending === null ? null : [...pending].slice(0, MAX_BATCH_IDS);
		if (pending === null) this.pending.delete(entity);
		else {
			for (const id of ids!) pending.delete(id);
			if (!pending.size) this.pending.delete(entity);
		}
		const notice = JSON.stringify({version: 1, eventId: randomUUID(), origin: this.origin, entity, ids});
		this.active = Promise.resolve()
			.then(() => this.connections!.publish(this.channel, notice))
			.then(() => {
				this.counters.published += 1;
			})
			.catch((error: unknown) => this.reportFailure(error))
			.finally(() => {
				this.active = null;
				this.pump();
			});
	}

	/** 严格校验通知，重复消息可重复失效，畸形消息仅保守清理本地缓存。 */
	private receive(value: string): void {
		if (this.stopped) return;
		try {
			if (Buffer.byteLength(value) > MAX_NOTICE_BYTES) throw new Error('Metadata notice exceeds byte limit');
			const notice = JSON.parse(value);
			const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
			if (
				notice?.version !== 1 ||
				typeof notice.eventId !== 'string' ||
				!uuid.test(notice.eventId) ||
				typeof notice.origin !== 'string' ||
				!uuid.test(notice.origin) ||
				!['channel', 'guild'].includes(notice.entity) ||
				(notice.ids !== null &&
					(!Array.isArray(notice.ids) ||
						notice.ids.length > MAX_BATCH_IDS ||
						notice.ids.some((id: unknown) => typeof id !== 'string' || !/^[1-9]\d{0,19}$/.test(id))))
			) {
				throw new Error('Malformed metadata notice');
			}
			if (notice.origin === this.origin) return;
			this.apply({entity: notice.entity, ids: notice.ids});
			this.counters.received += 1;
		} catch (error) {
			this.counters.malformed += 1;
			this.clearLocal();
			this.reportFailure(error);
		}
	}

	/** 同时清理两类本地状态，不改变缓存开关和固定有效期。 */
	private clearLocal(): void {
		this.apply({entity: 'channel', ids: null});
		this.apply({entity: 'guild', ids: null});
	}

	/** 统计有限队列中的实体键数，类别清空不占逐键容量。 */
	private pendingKeys(): number {
		let size = 0;
		for (const ids of this.pending.values()) size += ids?.size ?? 0;
		return size;
	}

	/** 错误仅进入固定维度指标和限频日志，不传播到业务调用方。 */
	private reportFailure(error: unknown): void {
		this.counters.failures += 1;
		this.options.onError?.(error);
	}

	/** 输出不含实体标识的通知水位和失败指标。 */
	renderMetrics(): string {
		return [
			...Object.entries(this.counters).map(
				([name, value]) => `fluxer_cassandra_metadata_notifications_${name}_total ${value}`,
			),
			`fluxer_cassandra_metadata_notifications_pending_keys ${this.pendingKeys()}`,
			`fluxer_cassandra_metadata_notifications_active ${Number(this.active !== null)}`,
			`fluxer_cassandra_metadata_notifications_subscribed ${Number(this.subscribed)}`,
			'',
		].join('\n');
	}

	/** 停机只等待一个发布超时，然后关闭专用连接，不等待未发送通知。 */
	async shutdown(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		this.subscribed = false;
		if (this.retry) clearTimeout(this.retry);
		this.retry = null;
		this.pending.clear();
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			if (this.active)
				await Promise.race([
					this.active,
					new Promise<void>((resolve) => {
						timer = setTimeout(resolve, COMMAND_TIMEOUT_MS);
					}),
				]);
		} finally {
			if (timer) clearTimeout(timer);
			this.connections?.close();
		}
	}
}
