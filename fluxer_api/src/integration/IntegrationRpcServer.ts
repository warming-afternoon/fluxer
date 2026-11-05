// SPDX-License-Identifier: AGPL-3.0-or-later

import {IntegrationError} from '@app/integration/IntegrationError';
import {IntegrationSchemas} from '@app/integration/IntegrationSchemas';
import type {IntegrationService} from '@app/integration/IntegrationService';
import {FluxerError} from '@fluxer/errors/src/FluxerError';
import type {Msg, NatsConnection, Subscription} from '@nats-io/transport-node';
import {ZodError} from 'zod';

/** 隔离集成 RPC 的订阅、并发、回复命名空间及错误边界 */
export class IntegrationRpcServer {
	/** 停止时需要取消的队列订阅 */
	private readonly subscriptions: Array<Subscription> = [];

	/** 已接受但尚未结束的请求任务 */
	private readonly pending = new Set<Promise<void>>();

	/** 禁止停止后继续接受新请求 */
	private stopped = false;

	/** 记录订阅错误并阻止就绪状态 */
	private subscriptionFailed = false;

	/** 全部订阅完成刷新后才标记启动成功 */
	private started = false;

	/** 限制并发和返回主题，避免敏感凭据被任意路由 */
	constructor(
		/** 专用于外部集成 RPC 的连接 */
		private readonly connection: NatsConnection,

		/** 执行鉴权与业务分派的服务 */
		private readonly service: IntegrationService,

		/** 允许同时接受的请求上限 */
		private readonly maxInflight: number,

		/** 允许返回响应的客户端收件箱前缀 */
		private readonly replyPrefixes: Array<string>,

		/** 仅可信 Forum 可使用的凭据与内容操作响应前缀 */
		private readonly forumReplyPrefix = '_INBOX.forum.',
	) {
		if (!Number.isInteger(maxInflight) || maxInflight < 1 || maxInflight > 256)
			throw new Error('Invalid INTEGRATION_MAX_INFLIGHT');
		if (!replyPrefixes.length || replyPrefixes.some((prefix) => !/^_INBOX\.[A-Za-z0-9_-]+\.$/.test(prefix)))
			throw new Error('Integration reply prefixes must name dedicated client inbox namespaces');
		if (!replyPrefixes.includes(forumReplyPrefix)) throw new Error('Forum reply prefix must be explicitly allowed');
	}

	/** 注册队列组消费者，在停止前跟踪所有在途工作 */
	async start(): Promise<void> {
		for (const subject of Object.keys(IntegrationSchemas)) {
			this.subscriptions.push(
				this.connection.subscribe(subject, {
					queue: 'fluxer-integration-v1',
					callback: (error, message) => {
						if (error) {
							this.subscriptionFailed = true;
							return;
						}
						if (this.stopped) return;
						const task = this.handle(message)
							.catch(() => {})
							.finally(() => this.pending.delete(task));
						this.pending.add(task);
					},
				}),
			);
		}
		await this.connection.flush();
		if (this.subscriptionFailed) throw new Error('Integration RPC subscription rejected');
		this.started = true;
	}

	/** 将订阅权限错误纳入进程就绪状态 */
	isReady(): boolean {
		return this.started && !this.stopped && !this.subscriptionFailed;
	}

	/** 安全解析请求并返回固定错误结构 */
	private async handle(message: Msg): Promise<void> {
		// 先验证回复命名空间，会话凭据只能返回 Forum 专用收件箱。
		const reply = message.reply;
		if (
			!reply ||
			reply.length > 256 ||
			!/^[a-zA-Z0-9_.-]+$/.test(reply) ||
			!this.replyPrefixes.some((prefix) => reply.startsWith(prefix))
		)
			return;
		if (
			(message.subject.startsWith('rpc.auth.') ||
				message.subject.startsWith('rpc.content.') ||
				message.subject.startsWith('rpc.preferences.') ||
				message.subject === 'rpc.identity.v1.login_eligibility' ||
				message.subject === 'rpc.identity.v1.rebind_service') &&
			!reply.startsWith(this.forumReplyPrefix)
		)
			return;
		try {
			if (this.pending.size >= this.maxInflight)
				throw new IntegrationError('BUSY', 'Integration concurrency limit reached', true);
			// 只有携带正文的创建与编辑接口使用较大的载荷上限。
			const maxRequestBytes = ['rpc.content.v1.thread.create_service', 'rpc.content.v1.starter.edit_service'].includes(
				message.subject,
			)
				? 65_536
				: 16_384;
			if (message.data.length > maxRequestBytes) throw new IntegrationError('INVALID_REQUEST', 'Request too large');
			let input: unknown;
			try {
				input = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(message.data));
			} catch {
				throw new IntegrationError('INVALID_REQUEST', 'Request must be UTF-8 JSON');
			}
			const data = await this.service.dispatch(message.subject, input);
			message.respond(JSON.stringify({ok: true, data}));
		} catch (error) {
			// 对未知异常只返回固定依赖错误，避免泄露内部状态和敏感字段。
			let safe: IntegrationError;
			if (error instanceof IntegrationError) {
				safe = error;
			} else if (error instanceof FluxerError && error.status >= 400 && error.status < 500) {
				safe = new IntegrationError(error.code, error.code, error.status === 429);
			} else if (error instanceof ZodError) {
				safe = new IntegrationError('INVALID_REQUEST', 'Request validation failed');
			} else {
				safe = new IntegrationError('UNAVAILABLE', 'Integration dependency unavailable', true);
			}
			message.respond(
				JSON.stringify({ok: false, error: {code: safe.code, message: safe.message, retryable: safe.retryable}}),
			);
		}
	}

	/** 停止接收并等待已接受请求完成后关闭连接 */
	async stop(): Promise<void> {
		this.stopped = true;
		for (const subscription of this.subscriptions) subscription.unsubscribe();
		await Promise.allSettled([...this.pending]);
		await this.connection.drain();
	}
}
