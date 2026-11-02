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
	finishIntegrationContentChange,
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

	async upsertMessage(data: MessageRow, oldData?: MessageRow | null, opts?: UpsertMessageOptions): Promise<Message> {
		await prepareIntegrationContentChange(data.channel_id);
		const message = await this.dataRepo.upsertMessage(data, oldData);
		if (!oldData && !opts?.skipParentLastMessageId) {
			await this.channelDataRepo.updateLastMessageId(
				data.channel_id,
				data.message_id,
				opts?.isInsert ? {isInsert: true} : undefined,
			);
		}
		await finishIntegrationContentChange(data.channel_id);
		return message;
	}

	async deleteMessage(
		channelId: ChannelID,
		messageId: MessageID,
		authorId: UserID,
		pinnedTimestamp?: Date,
	): Promise<void> {
		await prepareIntegrationContentChange(channelId, undefined, messageId.toString() === channelId.toString());
		await this.deletionRepo.deleteMessage(channelId, messageId, authorId, pinnedTimestamp);
		await finishIntegrationContentChange(channelId);
	}

	async bulkDeleteMessages(channelId: ChannelID, messageIds: Array<MessageID>): Promise<void> {
		await prepareIntegrationContentChange(
			channelId,
			undefined,
			messageIds.some((id) => id.toString() === channelId.toString()),
		);
		await this.deletionRepo.bulkDeleteMessages(channelId, messageIds);
		await finishIntegrationContentChange(channelId);
	}

	async deleteAllChannelMessages(channelId: ChannelID): Promise<void> {
		await prepareIntegrationContentChange(channelId, undefined, true);
		await this.deletionRepo.deleteAllChannelMessages(channelId);
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

	async updateEmbeds(message: Message): Promise<void> {
		await prepareIntegrationContentChange(message.channelId);
		await this.dataRepo.updateEmbeds(message);
		await finishIntegrationContentChange(message.channelId);
	}
}
