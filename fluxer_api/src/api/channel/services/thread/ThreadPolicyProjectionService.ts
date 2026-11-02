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
		private readonly context: ApiContext,
		private readonly repository = new ChannelRepository(),
		private readonly policies = new ThreadPolicyRepository(),
	) {}

	/** 同步有效锁、归档索引、队列、搜索与网关；同操作重试修复后续步骤 */
	async project(threadId: ChannelID) {
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
		await getKVThreadAutoArchiveQueue().schedule(state, channel.lastMessageId);
		await this.context.services.worker.addJob('syncThreadSearchDocument', {threadId: threadId.toString()});
		const members = !state.archived
			? await this.repository.threads.listMembers(threadId, {limit: MAX_THREAD_MEMBERS})
			: undefined;
		await dispatchThreadEvents(this.context.services.gateway, state.guildId, [threadUpdateEvent(view, members)]);
		return state;
	}
}
