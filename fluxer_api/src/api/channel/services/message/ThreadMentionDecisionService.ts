// SPDX-License-Identifier: AGPL-3.0-or-later

import {ThreadMentionDecisionRepository} from '@app/api/channel/repositories/ThreadMentionDecisionRepository';
import {
	type ThreadMentionDecision,
	ThreadMentionDecisionSchema,
} from '@app/api/channel/services/message/ThreadMentionDecision';
import type {IGatewayService} from '@app/api/infrastructure/IGatewayService';
import {Logger} from '@app/api/Logger';
import type {Channel} from '@app/api/models/Channel';
import type {Message} from '@app/api/models/Message';
import {THREAD_CHANNEL_TYPES} from '@fluxer/constants/src/ThreadConstants';

const attachedDecisions = new WeakMap<Message, ThreadMentionDecision>();

/** 返回本次接纳已经持久化的私有决策，不进入普通消息序列化。 */
export function getAttachedThreadMentionDecision(message: Message): ThreadMentionDecision | undefined {
	return attachedDecisions.get(message);
}

/** 接纳阶段固定角色规模决策，后续投递和自动加入复用同一份结果。 */
export class ThreadMentionDecisionService {
	constructor(private readonly repository = new ThreadMentionDecisionRepository()) {}

	/** 普通帖子无需查库或展开受众，角色不可用时只跳过本消息角色。 */
	async ensure(
		channel: Channel,
		message: Message,
		gatewayService: IGatewayService,
	): Promise<ThreadMentionDecision | null> {
		if (!channel.guildId || !THREAD_CHANNEL_TYPES.has(channel.type) || !message.authorId) return null;
		const attached = attachedDecisions.get(message);
		if (attached) return attached;
		const directUserIds = Array.from(message.mentionedUserIds, (id) => id.toString());
		const roleIds = Array.from(message.mentionedRoleIds, (id) => id.toString());
		if (directUserIds.length > 1024 || roleIds.length > 1024)
			throw new Error('Thread mention input exceeds bounded protocol');
		let decision: ThreadMentionDecision = {
			version: 1,
			message_id: message.id.toString(),
			channel_id: channel.id.toString(),
			author_id: message.authorId.toString(),
			allowed_role_ids: [],
			role_user_ids: [],
			direct_user_ids: directUserIds,
			warnings: [],
		};
		if (directUserIds.length === 0 && roleIds.length === 0) {
			attachedDecisions.set(message, decision);
			return decision;
		}
		const stored = await this.repository.get(channel.id, message.id);
		if (stored) {
			this.assertBinding(stored, decision);
			attachedDecisions.set(message, stored);
			return stored;
		}
		if (roleIds.length > 0) {
			try {
				const capabilities = await gatewayService.getThreadMentionCapabilities();
				if (
					capabilities.version !== 1 ||
					capabilities.api_version !== 1 ||
					capabilities.worker_version !== 1 ||
					capabilities.protocol_ready !== true
				)
					throw new Error('Thread mention protocol capability unavailable');
				const resolved = ThreadMentionDecisionSchema.parse(
					await gatewayService.resolveThreadMentionDecision({
						guildId: channel.guildId,
						channelId: channel.id,
						messageId: message.id,
						authorId: message.authorId,
						roleIds,
						userIds: directUserIds,
					}),
				);
				this.assertBinding(resolved, decision);
				if (resolved.allowed_role_ids.some((id) => !roleIds.includes(id)))
					throw new Error('Unrequested thread role decision');
				if (
					resolved.warnings.some((reason) => reason !== 'role_group_too_large') &&
					(resolved.role_user_ids.length > 0 || resolved.allowed_role_ids.length > 0)
				)
					throw new Error('Rejected thread role decision contains candidates');
				decision = {...resolved, direct_user_ids: directUserIds};
			} catch (error) {
				Logger.warn({error, messageId: message.id.toString()}, 'Thread role decision unavailable; freezing role skip');
				decision.warnings = ['role_index_unavailable'];
			}
		}
		decision = await this.repository.insertOnce(decision, channel.id, message.id);
		this.assertBinding(decision, {
			message_id: message.id.toString(),
			channel_id: channel.id.toString(),
			author_id: message.authorId.toString(),
		});
		attachedDecisions.set(message, decision);
		return decision;
	}

	/** 消息、频道和作者绑定必须同时吻合，不能复用另一条消息的候选。 */
	private assertBinding(
		actual: ThreadMentionDecision,
		expected: Pick<ThreadMentionDecision, 'message_id' | 'channel_id' | 'author_id'>,
	): void {
		if (
			actual.message_id !== expected.message_id ||
			actual.channel_id !== expected.channel_id ||
			actual.author_id !== expected.author_id
		) {
			throw new Error('Thread mention decision binding mismatch');
		}
	}
}
