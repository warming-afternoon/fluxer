// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ApiContext} from '@app/api/ApiContext';
import type {ChannelID} from '@app/api/BrandedTypes';
import {ChannelRepository} from '@app/api/channel/ChannelRepository';
import {dispatchThreadEvents, threadUpdateEvent} from '@app/api/channel/services/thread/ThreadDispatch';
import {ThreadPolicyRepository} from '@app/api/channel/services/thread/ThreadPolicyRepository';
import {loadThreadView} from '@app/api/channel/services/thread/ThreadViews';
import {getKVThreadAutoArchiveQueue} from '@app/api/middleware/ServiceSingletons';
import {MAX_THREAD_MEMBERS} from '@fluxer/constants/src/ThreadConstants';
import {UnknownChannelError} from '@fluxer/errors/src/domains/channel/UnknownChannelError';

export class ThreadPolicyProjectionService {
	/** 从持久来源重建原生有效状态，保留原生管理员的基态 */
	constructor(
		/** 提供原生工作队列与网关服务的请求上下文。 */
		private readonly context: ApiContext,

		/** 保存讨论区权威状态及其索引。 */
		private readonly repository = new ChannelRepository(),

		/** 读取各来源的持久锁定策略。 */
		private readonly policies = new ThreadPolicyRepository(),
	) {}

	/** 同步有效锁、归档索引、队列、搜索与网关；同操作重试修复后续步骤 */
	async project(threadId: ChannelID) {
		// 汇总来源锁后投影原生状态，保留原生管理员设置的基态。
		const active = await this.policies.hasActiveLock(threadId);
		const transition = await this.repository.threads.projectExternalLock(threadId, active);
		if (!transition) throw new UnknownChannelError();
		const state = transition.state;
		const [channel, parent] = await Promise.all([
			this.repository.channelData.findUnique(threadId),
			this.repository.channelData.findUnique(state.parentId),
		]);
		if (!channel || !parent) throw new UnknownChannelError();
		const view = await loadThreadView(this.repository, channel, state, parent);
		// 状态持久化后更新归档队列、搜索和网关，失败交由原操作恢复。
		await getKVThreadAutoArchiveQueue().schedule(state, channel.lastMessageId);
		await this.context.services.worker.addJob('syncThreadSearchDocument', {threadId: threadId.toString()});
		const members = !state.archived
			? await this.repository.threads.listMembers(threadId, {limit: MAX_THREAD_MEMBERS})
			: undefined;
		await dispatchThreadEvents(this.context.services.gateway, state.guildId, [threadUpdateEvent(view, members)]);
		return state;
	}
}
