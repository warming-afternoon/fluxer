// SPDX-License-Identifier: AGPL-3.0-or-later

import {createHash, randomUUID} from 'node:crypto';
import type {UserID} from '@app/api/BrandedTypes';
import type {MessageUpdateRequest} from '@app/api/channel/MessageTypes';
import type {AuthenticatedChannel} from '@app/api/channel/services/AuthenticatedChannel';
import type {Message} from '@app/api/models/Message';
import type {UserRepository} from '@app/api/user/repositories/UserRepository';
import {IntegrationIdentityRepository} from '@app/integration/IntegrationIdentityRepository';
import {IntegrationOperationRepository} from '@app/integration/IntegrationOperationRepository';
import {UserFlags} from '@fluxer/constants/src/UserConstants';
import {MissingPermissionsError} from '@fluxer/errors/src/domains/core/MissingPermissionsError';

export class StarterEditCapabilityService {
	/** 保留原作者，按合并关系向规范用户授予仅主帖正文的编辑能力 */
	constructor(
		private readonly users: UserRepository,
		private readonly identities = new IntegrationIdentityRepository(),
		private readonly operations = new IntegrationOperationRepository(),
	) {}

	/** 在实际写入前记录操作人 B、原作者 C 及前后正文，失败记录保留为待确认 */
	async authorize(
		actor: UserID,
		auth: AuthenticatedChannel,
		message: Message,
		data: MessageUpdateRequest,
	): Promise<string | null> {
		if (process.env.FLUXER_THREAD_POLICY_ENABLED !== 'true' || message.authorId === actor || !message.authorId)
			return null;
		if (
			!auth.thread?.state.hasStarter ||
			BigInt(message.id) !== BigInt(auth.channel.id) ||
			!auth.thread.parent.isThreadOnly()
		)
			return null;
		const original = await this.users.findUnique(message.authorId);
		if (!original?.traits.has('discord_integration') || (original.flags & UserFlags.DISABLED) === 0n) return null;
		if ((await this.identities.canonicalUserId(message.authorId)) !== actor) return null;
		if (Object.keys(data).some((key) => key !== 'content' && key !== 'allowed_mentions'))
			throw new MissingPermissionsError();
		// 替代作者编辑不能借原作者名义新增通知，只保留可见正文修改。
		data.allowed_mentions = {parse: [], replied_user: false};
		const operationId = `starter_edit_${randomUUID().replaceAll('-', '')}`;
		const payload = JSON.stringify({
			kind: 'starter_edit',
			actor_user_id: actor.toString(),
			original_author_id: message.authorId.toString(),
			channel_id: message.channelId.toString(),
			message_id: message.id.toString(),
			before_content: message.content,
			after_content: data.content,
			occurred_at: new Date().toISOString(),
		});
		await this.operations.allocate({
			operation_id: operationId,
			fingerprint: createHash('sha256').update(payload).digest('hex'),
			actor_id: actor,
			payload,
			result: null,
		});
		return operationId;
	}

	/** 写入成功后提交审计结果，不替换消息作者字段 */
	async complete(operationId: string, messageId: string): Promise<void> {
		await this.operations.complete(operationId, {message_id: messageId, edited: true});
	}
}
