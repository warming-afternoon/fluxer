// SPDX-License-Identifier: AGPL-3.0-or-later

import {createHash, randomUUID} from 'node:crypto';
import {Logger} from '@app/api/Logger';
import {IntegrationCreationEventGate} from '@app/integration/IntegrationCreationEventGate';
import {IntegrationEventJournal, type JournalEvent} from '@app/integration/IntegrationEventJournal';
import {INTEGRATION_QUERY_OPTIONS} from '@app/integration/IntegrationIdentityRepository';
import {
	getIntegrationNatsConnection,
	shutdownIntegrationNatsConnection,
} from '@app/integration/IntegrationNatsConnection';
import {IntegrationReconciliation} from '@app/integration/IntegrationReconciliation';
import {jetstream} from '@nats-io/jetstream';
import {getClient} from '@pkgs/cassandra/src/Client';

/** 阻止关闭期间启动新的恢复或即时投递 */
let stopped = false;
/** 每秒触发一次有界恢复的定时器 */
let timer: ReturnType<typeof setInterval> | undefined;
/** 当前恢复页的任务，供互斥推进和退出等待 */
let running: Promise<void> | undefined;
/** 下次处理的持久事件分片 */
let shard = 0;
const reconciliation = new IntegrationReconciliation();
/** 各分片已完成投递位置，失败时停留在前一事件 */
const pendingCursors = new Map<number, string>();
/** 各分片资源对账的位置，与待发事件游标独立 */
const trackedCursors = new Map<number, string>();

/** 只有远端持久确认才移除待发事件，会话撤销必须先观察到权威失效 */
async function deliver(event: JournalEvent): Promise<void> {
	const data = JSON.parse(event.payload) as Record<string, unknown>;
	if (event.subject.startsWith('events.content.v1.') && typeof data.creation_operation_id === 'string') {
		const status = await new IntegrationCreationEventGate().status(data.creation_operation_id, String(data.thread_id));
		if (status === 'pending') return;
		if (status === 'failed') {
			await new IntegrationEventJournal().failCreation(`thread:${data.thread_id}`, data.creation_operation_id);
			return;
		}
		// 升级前已排队的暂态快照不能在创建提交后被当作最终结果发布。
		if (data.creation_completed !== true) {
			const journal = new IntegrationEventJournal();
			const resource = await journal.resource(`thread:${data.thread_id}`);
			if (!resource) throw new Error('Creation snapshot is missing its durable resource context');
			const {projectIntegrationContent} = await import('@app/integration/IntegrationContentEvents');
			await projectIntegrationContent(
				resource as unknown as import('@app/integration/IntegrationContentEvents').ContentResource,
			);
			await journal.acknowledge(event);
			return;
		}
	}
	// 新状态已覆盖旧事件时，只确认旧记录，不再向外发布。
	if (event.subject.startsWith('events.content.v1.') && Number.isSafeInteger(data.state_version)) {
		const journal = new IntegrationEventJournal();
		if (await journal.superseded(event, `thread:${data.thread_id}`, Number(data.state_version))) {
			await journal.acknowledge(event);
			return;
		}
	}
	// 原生会话仍存在时延迟失效通知，避免消费者先于权威存储撤销。
	if (event.subject === 'events.auth.v1.session_invalidated') {
		const state = await getClient().execute(
			'SELECT user_id, created_at FROM auth_sessions WHERE session_id_hash = ?',
			[Buffer.from(String(data.session_id_hash), 'base64url')],
			INTEGRATION_QUERY_OPTIONS,
		);
		if (state.first()?.created_at != null) return;
	}
	const client = await getIntegrationNatsConnection();
	await jetstream(client).publish(event.subject, event.payload, {msgID: String(data.event_id), timeout: 3000});
	await new IntegrationEventJournal().acknowledge(event);
}

/** 分片和键游标限制每次恢复成本，失败记录不会因重试次数被丢弃 */
export async function recoverIntegrationEventsPage(): Promise<void> {
	const current = shard;
	shard = (shard + 1) % 16;
	const journal = new IntegrationEventJournal();
	const pending = await journal.pending(current, pendingCursors.get(current));
	let completedKey = pendingCursors.get(current) ?? 'p:';
	let interrupted = false;
	for (const event of pending) {
		try {
			await deliver(event);
			completedKey = event.key;
		} catch (error) {
			Logger.warn({err: error, subject: event.subject}, 'Durable integration event remains pending');
			interrupted = true;
			break;
		}
	}
	pendingCursors.set(current, interrupted || pending.length === 100 ? completedKey : 'p:');
	const tracked = await journal.tracked(current, trackedCursors.get(current));
	const {projectIntegrationContent} = await import('@app/integration/IntegrationContentEvents');
	for (const entry of tracked) {
		try {
			if (entry.key.startsWith('d:nsfw:')) {
				const {reconcileNsfwPreference} = await import('@app/api/user/NsfwDisplayPreferenceService');
				await reconcileNsfwPreference(JSON.parse(entry.payload), entry.key.slice(2));
			} else if (entry.key.startsWith('d:user:')) {
				const {projectIntegrationUser} = await import('@app/integration/IntegrationAuthEvents');
				await projectIntegrationUser(String(JSON.parse(entry.payload).user_id));
			} else await projectIntegrationContent(JSON.parse(entry.payload));
		} catch (error) {
			Logger.warn({err: error, key: entry.key}, 'Tracked native resource reconciliation failed');
		}
	}
	trackedCursors.set(current, tracked.length === 100 ? tracked[tracked.length - 1]!.key : 'd:');
	await reconciliation.step();
}

/** 进程启动时恢复持久事件，发布连接中断不影响日志保留 */
export function startIntegrationEvents(): void {
	if (!process.env.INTEGRATION_NATS_URL || timer) return;
	stopped = false;
	/** 同一时刻仅推进一页，避免慢依赖造成恢复任务堆积 */
	const tick = () => {
		if (running || stopped) return;
		running = recoverIntegrationEventsPage()
			.catch((error) => Logger.warn({err: error}, 'Integration recovery deferred'))
			.finally(() => {
				running = undefined;
			});
	};
	timer = setInterval(tick, 1000);
	timer.unref();
	tick();
}

/** 持久化后尝试发送，发布失败由恢复循环继续而不吞掉存储失败 */
export async function publishIntegrationEvent(
	subject: string,
	data: Record<string, string | number | ReadonlyArray<string>>,
	options: {
		/** 仅持久化，由恢复循环异步投递 */
		defer?: boolean;

		/** 调用方提供的稳定事件标识 */
		eventId?: string;
	} = {},
): Promise<void> {
	if (!process.env.INTEGRATION_NATS_URL) return;
	// 可重放的权威状态使用稳定摘要，其他事件分配独立标识。
	const stable = data.session_id_hash || data.authority_version !== undefined;
	const eventId =
		options.eventId ??
		(stable ? createHash('sha256').update(JSON.stringify({subject, data})).digest('hex') : randomUUID());
	await new IntegrationEventJournal().enqueue(subject, data, eventId);
	if (stopped) return;
	startIntegrationEvents();
	if (!options.defer) {
		try {
			const bucket = createHash('sha256').update(eventId).digest()[0]! % 16;
			const event = (await new IntegrationEventJournal().pending(bucket, `p:${eventId.slice(0, -1)}`, 100)).find(
				(item) => item.key === `p:${eventId}`,
			);
			if (event) await deliver(event);
		} catch (error) {
			Logger.warn({err: error, subject}, 'Integration event persisted for retry');
		}
	}
}

/** 关闭恢复循环并等待当前页，未确认事件保留在权威存储 */
export async function shutdownIntegrationEvents(): Promise<void> {
	stopped = true;
	clearInterval(timer);
	timer = undefined;
	await running;
	await shutdownIntegrationNatsConnection();
}
