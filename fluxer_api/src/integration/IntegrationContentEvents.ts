// SPDX-License-Identifier: AGPL-3.0-or-later

import {makeSignedAttachmentCdnUrl} from '@app/api/attachment/AttachmentUrls';
import {type ChannelID, channelIdToMessageId, createChannelID} from '@app/api/BrandedTypes';
import {ChannelRepository} from '@app/api/channel/ChannelRepository';
import {Logger} from '@app/api/Logger';
import {getCacheService} from '@app/api/middleware/ServiceSingletons';
import {IntegrationCreationEventGate} from '@app/integration/IntegrationCreationEventGate';
import {IntegrationEventJournal} from '@app/integration/IntegrationEventJournal';

export interface ContentResource {
	/** 原生服务器范围 */
	guild_id: string;

	/** 所属论坛频道 */
	channel_id: string;

	/** 原生帖子频道 */
	thread_id: string;

	/** 仅显式原生删除路径能够设置删除意图 */
	deleting?: boolean;

	/** 通用创建操作相关性，供消费方关联自己已持久化的意图 */
	creation_operation_id?: string;
}

/** 在任何原生写入之前持久化资源意图，未配置集成时保持现有实例行为 */
export async function prepareIntegrationContentChange(
	threadId: ChannelID,
	explicit?: ContentResource,
	deleting = false,
): Promise<void> {
	if (!process.env.INTEGRATION_NATS_URL) return;
	const state = explicit ? null : await new ChannelRepository().threads.getState(threadId);
	const resource =
		explicit ??
		(state
			? {
					guild_id: state.guildId.toString(),
					channel_id: state.parentId.toString(),
					thread_id: threadId.toString(),
					deleting,
				}
			: null);
	const forums = (process.env.INTEGRATION_FORUM_CHANNEL_IDS ?? '').split(',');
	if (!resource || resource.guild_id !== process.env.INTEGRATION_GUILD_ID || !forums.includes(resource.channel_id))
		return;
	await new IntegrationEventJournal().track(
		`thread:${resource.thread_id}`,
		resource as unknown as Record<string, unknown>,
	);
}

/** 以权威原生快照重算表情与正文；普通查询失败和不存在不会被误报为删除 */
export async function projectIntegrationContent(resource: ContentResource): Promise<void> {
	if (!process.env.INTEGRATION_NATS_URL) return;
	const forums = (process.env.INTEGRATION_FORUM_CHANNEL_IDS ?? '').split(',');
	if (resource.guild_id !== process.env.INTEGRATION_GUILD_ID || !forums.includes(resource.channel_id)) return;
	const cache = getCacheService();
	const lockKey = `integration:projection:${resource.thread_id}`;
	const lease = await cache.acquireLock(lockKey, 60);
	if (!lease) return;
	try {
		const repository = new ChannelRepository();
		const intent = await new IntegrationEventJournal().resource(`thread:${resource.thread_id}`);
		if (intent?.creation_failed === true) return;
		const deletingIntent = !!resource.deleting || intent?.deleting === true;
		const creationOperationId = resource.creation_operation_id ?? intent?.creation_operation_id ?? null;
		if (typeof creationOperationId === 'string') {
			const status = await new IntegrationCreationEventGate().status(creationOperationId, resource.thread_id);
			if (status === 'pending') return;
			if (status === 'failed') {
				await new IntegrationEventJournal().failCreation(`thread:${resource.thread_id}`, creationOperationId);
				return;
			}
		}
		const threadId = createChannelID(BigInt(resource.thread_id));
		const state = await repository.threads.getState(threadId);
		if (!state && !deletingIntent) return;
		if (state && (state.guildId.toString() !== resource.guild_id || !forums.includes(state.parentId.toString())))
			return;
		const channel = state ? await repository.channelData.findUnique(threadId) : null;
		const starter = state ? await repository.messages.getMessage(threadId, channelIdToMessageId(threadId)) : null;
		// 原生创建尚未写完首帖时不发送残缺作品。
		if (state?.hasStarter && (!channel || !starter) && !deletingIntent) return;
		const deleted = !state || (deletingIntent && state.hasStarter && !starter);
		const rows = state
			? await repository.messageInteractions.listMessageReactions(threadId, channelIdToMessageId(threadId))
			: [];
		const reactions = new Map<string, {emoji: {id: string | null; name: string; animated: boolean}; count: number}>();
		for (const row of rows) {
			const key = `${row.emojiId}:${row.emojiName}`;
			const previous = reactions.get(key);
			reactions.set(key, {
				emoji: {
					id: row.emojiId === 0n ? null : row.emojiId.toString(),
					name: row.emojiName,
					animated: row.isEmojiAnimated,
				},
				count: (previous?.count ?? 0) + 1,
			});
		}
		const stats = state ? await repository.threads.getStats(threadId) : null;
		const parentConfig = state ? await repository.threads.getParentConfig(state.guildId, state.parentId) : null;
		const appliedIds = new Set((state?.appliedTags ?? []).map((id) => id.toString()));
		const snapshot = {
			title: channel?.name ?? '',
			body: starter?.content ?? '',
			author_id: starter?.authorId?.toString() ?? channel?.ownerId?.toString() ?? null,
			images:
				starter?.attachments
					.filter((attachment) => attachment.contentType.startsWith('image/'))
					.map((attachment) => makeSignedAttachmentCdnUrl(threadId, attachment.id, attachment.filename)) ?? [],
			reactions: [...reactions]
				.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
				.map(([, value]) => value),
			reply_count: Math.max(0, (stats?.messageCount ?? 0) - (state?.hasStarter ? 1 : 0)),
			archived: state?.archived ?? false,
			locked: state?.locked ?? false,
			native_locked: state?.nativeLocked ?? state?.locked ?? false,
			native_archived: state?.nativeArchived ?? state?.archived ?? false,
			external_locked: state?.externalLocked ?? false,
			tags: (parentConfig?.availableTags ?? [])
				.filter((tag) => appliedIds.has(tag.id.toString()))
				.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
				.map((tag) => ({
					id: tag.id.toString(),
					name: tag.name,
					moderated: tag.moderated,
					emoji: {id: tag.emojiId?.toString() ?? null, name: tag.emojiName},
				})),
		};
		if (!(await cache.extendLock(lockKey, lease, 60))) throw new Error('Integration projection lease expired');
		await new IntegrationEventJournal().snapshot(
			`thread:${resource.thread_id}`,
			deleted ? 'events.content.v1.thread.deleted' : 'events.content.v1.thread.changed',
			{
				platform: 'fluxer',
				guild_id: resource.guild_id,
				channel_id: state?.parentId.toString() ?? resource.channel_id,
				thread_id: resource.thread_id,
				creation_operation_id: creationOperationId,
				...(creationOperationId ? {creation_completed: true} : {}),
				snapshot,
			},
		);
	} finally {
		await cache.releaseLock(lockKey, lease);
	}
}

/** 原生网关分发路径立即触发快照，失败由写前跟踪索引恢复 */
export async function finishIntegrationContentChange(threadId: ChannelID): Promise<void> {
	if (!process.env.INTEGRATION_NATS_URL) return;
	try {
		const tracked = await new IntegrationEventJournal().resource(`thread:${threadId}`);
		if (tracked) await projectIntegrationContent(tracked as unknown as ContentResource);
	} catch (error) {
		Logger.warn({err: error, threadId: threadId.toString()}, 'Integration snapshot deferred to durable reconciliation');
	}
}
