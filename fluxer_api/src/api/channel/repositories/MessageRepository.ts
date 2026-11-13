// SPDX-License-Identifier: AGPL-3.0-or-later

import type {AttachmentID, ChannelID, MessageID, UserID} from '@app/api/BrandedTypes';
import type {ChannelDataRepository} from '@app/api/channel/repositories/ChannelDataRepository';
import {MessageAuthorRepository} from '@app/api/channel/repositories/message/MessageAuthorRepository';
import {MessageDataRepository} from '@app/api/channel/repositories/message/MessageDataRepository';
import {MessageDeletionRepository} from '@app/api/channel/repositories/message/MessageDeletionRepository';
import {fetchOne} from '@app/api/database/CassandraQueryExecution';
import type {AttachmentLookupRow, MessageRow} from '@app/api/database/types/MessageTypes';
import type {Message} from '@app/api/models/Message';
import {AttachmentLookup} from '@app/api/Tables';
import {
	finishIntegrationActivity,
	finishIntegrationContentChange,
	prepareIntegrationActivity,
	prepareIntegrationContentChange,
} from '@app/integration/IntegrationContentHooks';

export interface UpsertMessageOptions {
	isInsert?: boolean;
	skipParentLastMessageId?: boolean;
}

const LOOKUP_ATTACHMENT_BY_CHANNEL_AND_FILENAME_QUERY = AttachmentLookup.selectCql({
	where: [
		AttachmentLookup.where.eq('channel_id'),
		AttachmentLookup.where.eq('attachment_id'),
		AttachmentLookup.where.eq('filename'),
	],
	limit: 1,
});

export class MessageRepository {
	private dataRepo: MessageDataRepository;
	private deletionRepo: MessageDeletionRepository;
	private authorRepo: MessageAuthorRepository;
	private channelDataRepo: ChannelDataRepository;

	constructor(channelDataRepo: ChannelDataRepository) {
		this.dataRepo = new MessageDataRepository();
		this.deletionRepo = new MessageDeletionRepository(this.dataRepo);
		this.authorRepo = new MessageAuthorRepository(this.dataRepo);
		this.channelDataRepo = channelDataRepo;
	}

	async listMessages(
		channelId: ChannelID,
		beforeMessageId?: MessageID,
		limit?: number,
		afterMessageId?: MessageID,
	): Promise<Array<Message>> {
		return this.dataRepo.listMessages(channelId, beforeMessageId, limit, afterMessageId);
	}

	async getMessage(channelId: ChannelID, messageId: MessageID): Promise<Message | null> {
		return this.dataRepo.getMessage(channelId, messageId);
	}

	/** 保存原生消息及关联索引，通知集成内容变更。 */
	async upsertMessage(data: MessageRow, oldData?: MessageRow | null, opts?: UpsertMessageOptions): Promise<Message> {
		await prepareIntegrationContentChange(data.channel_id);
		// 首帖和已知编辑不产生回复增长，重复创建以原生存在状态为准。
		const activity =
			data.message_id.toString() !== data.channel_id.toString() && !oldData
				? await prepareIntegrationActivity(data.channel_id, 'reply', async () =>
						(await this.dataRepo.getMessage(data.channel_id, data.message_id)) ? 0 : 1,
					)
				: null;
		const message =
			oldData || opts?.skipParentLastMessageId
				? await this.dataRepo.upsertMessage(data, oldData)
				: await this.dataRepo.upsertMessage(data, oldData, () =>
						this.channelDataRepo.updateLastMessageId(
							data.channel_id,
							data.message_id,
							opts?.isInsert ? {isInsert: true} : undefined,
						),
					);
		await finishIntegrationActivity(activity);
		await finishIntegrationContentChange(data.channel_id);
		return message;
	}

	/** 删除原生消息并同步关联内容状态。 */
	async deleteMessage(
		channelId: ChannelID,
		messageId: MessageID,
		authorId: UserID,
		pinnedTimestamp?: Date,
	): Promise<void> {
		await prepareIntegrationContentChange(channelId, undefined, messageId.toString() === channelId.toString());
		// 已不存在的消息重复删除时不扣减回复计数。
		const activity =
			messageId.toString() !== channelId.toString()
				? await prepareIntegrationActivity(channelId, 'reply', async () =>
						(await this.dataRepo.getMessage(channelId, messageId)) ? -1 : 0,
					)
				: null;
		await this.deletionRepo.deleteMessage(channelId, messageId, authorId, pinnedTimestamp);
		await finishIntegrationActivity(activity);
		await finishIntegrationContentChange(channelId);
	}

	/** 批量删除指定消息并同步关联内容状态。 */
	async bulkDeleteMessages(channelId: ChannelID, messageIds: Array<MessageID>): Promise<void> {
		await prepareIntegrationContentChange(
			channelId,
			undefined,
			messageIds.some((id) => id.toString() === channelId.toString()),
		);
		// 管理删除只统计当前存在的非首帖消息，原生写成功后才持久化增量。
		const activity = await prepareIntegrationActivity(channelId, 'reply', async () => {
			const replies = messageIds.filter((id) => id.toString() !== channelId.toString());
			const existing = await this.dataRepo.getMessagesByIds(channelId, replies);
			return -existing.size;
		});
		await this.deletionRepo.bulkDeleteMessages(channelId, messageIds);
		await finishIntegrationActivity(activity);
		await finishIntegrationContentChange(channelId);
	}

	/** 删除频道内消息并同步集成内容状态。 */
	async deleteAllChannelMessages(channelId: ChannelID): Promise<void> {
		await prepareIntegrationContentChange(channelId, undefined, true);
		// 管理删除只统计当前存在的非首帖消息，原生写成功后才持久化增量。
		const activity = await prepareIntegrationActivity(channelId, 'reply', async () => {
			let count = 0;
			let before: MessageID | undefined;
			while (true) {
				const messages = await this.dataRepo.listMessages(channelId, before, 100);
				if (messages.length === 0) break;
				count += messages.filter((message) => message.id.toString() !== channelId.toString()).length;
				before = messages[messages.length - 1]!.id;
			}
			return -count;
		});
		await this.deletionRepo.deleteAllChannelMessages(channelId);
		await finishIntegrationActivity(activity);
		await finishIntegrationContentChange(channelId);
	}

	async listMessagesByAuthor(
		authorId: UserID,
		limit?: number,
		lastMessageId?: MessageID,
	): Promise<
		Array<{
			channelId: ChannelID;
			messageId: MessageID;
		}>
	> {
		return this.authorRepo.listMessagesByAuthor(authorId, limit, lastMessageId);
	}

	/** 匿名化消息作者信息并同步内容变更。 */
	async anonymizeMessage(channelId: ChannelID, messageId: MessageID, newAuthorId: UserID): Promise<void> {
		await prepareIntegrationContentChange(channelId);
		await this.authorRepo.anonymizeMessage(channelId, messageId, newAuthorId);
		await finishIntegrationContentChange(channelId);
	}

	async lookupAttachmentByChannelAndFilename(
		channelId: ChannelID,
		attachmentId: AttachmentID,
		filename: string,
	): Promise<MessageID | null> {
		const result = await fetchOne<AttachmentLookupRow>(LOOKUP_ATTACHMENT_BY_CHANNEL_AND_FILENAME_QUERY, {
			channel_id: channelId,
			attachment_id: attachmentId,
			filename,
		});
		return result ? result.message_id : null;
	}

	/** 更新消息嵌入内容并同步内容变更。 */
	async updateEmbeds(message: Message): Promise<void> {
		await prepareIntegrationContentChange(message.channelId);
		await this.dataRepo.updateEmbeds(message);
		await finishIntegrationContentChange(message.channelId);
	}
}
