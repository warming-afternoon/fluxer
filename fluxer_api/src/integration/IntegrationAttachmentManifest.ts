// SPDX-License-Identifier: AGPL-3.0-or-later

import {createHash} from 'node:crypto';
import {
	type AttachmentID,
	type ChannelID,
	createAttachmentID,
	type MessageID,
	type UserID,
} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import type {AttachmentToProcess} from '@app/api/channel/AttachmentDTOs';
import {makeAttachmentCdnKey} from '@app/api/channel/services/message/MessageHelpers';
import type {MessageAttachment} from '@app/api/database/types/MessageTypes';
import type {IStorageService} from '@app/api/infrastructure/IStorageService';
import {
	currentIntegrationAttachmentOperation,
	currentIntegrationAttachmentScope,
} from '@app/integration/IntegrationAttachmentOperation';
import {IntegrationError} from '@app/integration/IntegrationError';
import {IntegrationOperationRepository} from '@app/integration/IntegrationOperationRepository';

export interface AttachmentManifestResult {
	/** 原生检查完成后的附件元数据，保留顺序与永久附件编号 */
	attachments: Array<MessageAttachment>;

	/** 原生病毒检测结果不因重试而被绕过 */
	hasVirusDetected: boolean;
}

export interface AttachmentManifestCheckpoint {
	/** 共用操作日志中的附件子操作 */
	id: string;

	/** 已持久处理结果，空值表示尚未完成原生扫描和复制 */
	result: AttachmentManifestResult | null;

	/** 复制前持久的永久附件编号，进程中断仍使用同一 CDN 目标 */
	attachmentIds: Array<AttachmentID>;
}

export class IntegrationAttachmentManifest {
	/** 复用现有永久操作日志，不引入重复附件或用户凭据表 */
	constructor(private readonly operations = new IntegrationOperationRepository()) {}

	/** 原生管线在接触上传对象前固定输入和所有者，重试只恢复同一不可变计划 */
	async begin(
		input: {
			messageId: MessageID;
			channelId: ChannelID;
			uploadChannelId: ChannelID;
			actorId: UserID;
			attachments: Array<AttachmentToProcess>;
		},
		allocateId: () => Promise<bigint>,
	): Promise<AttachmentManifestCheckpoint | null> {
		const operationId = currentIntegrationAttachmentOperation();
		if (!operationId) return null;
		const id = `${operationId}:attachments:${input.channelId}:${input.messageId}`;
		const payload = JSON.stringify(input, (_key, value) => (typeof value === 'bigint' ? value.toString() : value));
		const fingerprint = createHash('sha256').update(payload).digest('hex');
		const previous = await this.operations.find(id);
		const attachmentIds = previous ? [] : await Promise.all(input.attachments.map(() => allocateId()));
		const record = await this.operations.allocate({
			operation_id: id,
			actor_id: input.actorId,
			fingerprint,
			payload: previous?.payload ?? JSON.stringify({...JSON.parse(payload), attachmentIds: attachmentIds.map(String)}),
			result: null,
		});
		const plan = JSON.parse(record.payload) as {attachmentIds?: Array<string>};
		if (plan.attachmentIds?.length !== input.attachments.length)
			throw new IntegrationError('OPERATION_CONFLICT', 'Invalid prepared attachment identifiers');
		return {
			id,
			result: record.result ? this.decode(record.result) : null,
			attachmentIds: plan.attachmentIds.map((value) => createAttachmentID(BigInt(value))),
		};
	}

	/** 永久失败按复制前持久计划清理，包含尚未来得及写入完成结果的对象 */
	async discard(operationId: string, channelId: ChannelID, messageId: string, storage: IStorageService): Promise<void> {
		const record = await this.operations.find(`${operationId}:attachments:${channelId}:${messageId}`);
		if (!record) return;
		const plan = JSON.parse(record.payload) as {attachmentIds: Array<string>; attachments: Array<AttachmentToProcess>};
		for (const [index, id] of plan.attachmentIds.entries())
			await storage.deleteObject(
				Config.s3.buckets.cdn,
				makeAttachmentCdnKey(channelId, createAttachmentID(BigInt(id)), plan.attachments[index]!.filename),
			);
	}

	/** CDN 复制完成后、绑定上传和删除临时对象前保存原生结果，关闭不可重传窗口 */
	async save(
		checkpoint: AttachmentManifestCheckpoint,
		result: AttachmentManifestResult,
	): Promise<AttachmentManifestResult> {
		const encoded = JSON.stringify(result, (_key, value) => (typeof value === 'bigint' ? value.toString() : value));
		const stored = await this.operations.completeOnce(checkpoint.id, JSON.parse(encoded));
		return this.decode(JSON.stringify(stored));
	}

	/** 幂等正文编辑比较完整附件目标时读取已准备的永久附件编号 */
	async result(operationId: string, channelId: string, messageId: string): Promise<AttachmentManifestResult | null> {
		const record = await this.operations.find(`${operationId}:attachments:${channelId}:${messageId}`);
		return record?.result ? this.decode(record.result) : null;
	}

	/** 重试时临时上传已消费，预校验仅可复用同操作、同用户与同上传频道的已扫描大小 */
	async preparedUploadSize(uploadKey: string, actorId: UserID, uploadChannelId: ChannelID): Promise<bigint | null> {
		const scope = currentIntegrationAttachmentScope();
		if (!scope?.channelId || !scope.messageId) return null;
		const record = await this.operations.find(`${scope.operationId}:attachments:${scope.channelId}:${scope.messageId}`);
		if (!record?.result || record.actor_id !== actorId) return null;
		const plan = JSON.parse(record.payload) as {uploadChannelId: string; attachments: Array<AttachmentToProcess>};
		if (plan.uploadChannelId !== uploadChannelId.toString()) return null;
		const index = plan.attachments.findIndex((attachment) => attachment.upload_filename === uploadKey);
		if (index < 0) return null;
		const result = this.decode(record.result);
		return result.hasVirusDetected ? 0n : (result.attachments[index]?.size ?? null);
	}

	/** 仅还原原生 UDT 的整数类型，不从客户端输入直接构造已验证附件 */
	private decode(payload: string): AttachmentManifestResult {
		const parsed = JSON.parse(payload) as {attachments: Array<MessageAttachment>; hasVirusDetected: boolean};
		if (!Array.isArray(parsed.attachments) || typeof parsed.hasVirusDetected !== 'boolean')
			throw new IntegrationError('OPERATION_CONFLICT', 'Invalid prepared attachment result');
		return {
			hasVirusDetected: parsed.hasVirusDetected,
			attachments: parsed.attachments.map((attachment) => ({
				...attachment,
				attachment_id: createAttachmentID(BigInt(attachment.attachment_id)),
				size: BigInt(attachment.size),
			})),
		};
	}
}
