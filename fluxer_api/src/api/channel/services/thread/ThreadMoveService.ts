// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ChannelID, UserID} from '@app/api/BrandedTypes';
import type {ChannelRepository} from '@app/api/channel/ChannelRepository';
import {ThreadMoveRepository} from '@app/api/channel/repositories/ThreadMoveRepository';
import {dispatchThreadEvents, threadUpdateEvent} from '@app/api/channel/services/thread/ThreadDispatch';
import {serializeThreadForAudit, type ThreadView} from '@app/api/channel/services/thread/ThreadMappers';
import {loadThreadView} from '@app/api/channel/services/thread/ThreadViews';
import type {GuildAuditLogService} from '@app/api/guild/GuildAuditLogService';
import type {IGatewayService} from '@app/api/infrastructure/IGatewayService';
import {getWorkerService} from '@app/api/middleware/ServiceRegistry';
import {
	finishIntegrationContentChange,
	prepareIntegrationContentChange,
} from '@app/integration/IntegrationContentHooks';
import {AuditLogActionType} from '@fluxer/constants/src/AuditLogActionType';
import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import {MAX_THREAD_MEMBERS} from '@fluxer/constants/src/ThreadConstants';
import {ValidationErrorCodes} from '@fluxer/constants/src/ValidationErrorCodes';
import {InvalidChannelTypeError} from '@fluxer/errors/src/domains/channel/InvalidChannelTypeError';
import {UnknownChannelError} from '@fluxer/errors/src/domains/channel/UnknownChannelError';
import {InputValidationError} from '@fluxer/errors/src/domains/core/InputValidationError';

interface ThreadMoveServiceDeps {
	/** 原生频道、成员及帖子仓储。 */
	channelRepository: ChannelRepository;

	/** 网关事件入口，移动完成前同步新的权限归属。 */
	gatewayService: IGatewayService;

	/** 原生管理审计服务。 */
	guildAuditLogService: GuildAuditLogService;
}

/** 为已授权的内部服务提供同服务器论坛移动，不赋予普通用户通用移动权限。 */
export class ThreadMoveService {
	/** 外层调用者负责验证服务 ACL、资源允许列表并持久化操作计划。 */
	constructor(private readonly deps: ThreadMoveServiceDeps) {}

	/** 保持帖子和消息 ID 不变；失败向上传递，由原操作重试修复。 */
	async move(params: {
		/** 原生讨论区 ID。 */
		threadId: ChannelID;

		/** 操作计划保存的原论坛，重试时不重新取代。 */
		sourceParentId: ChannelID;

		/** 目标论坛，必须与原论坛属于同一服务器。 */
		targetParentId: ChannelID;

		/** 真实发起人，用于审计，不能伪装成历史主帖作者。 */
		userId: UserID;

		/** 操作原因。 */
		auditLogReason: string | null;
	}): Promise<ThreadView> {
		const {channelRepository, gatewayService, guildAuditLogService} = this.deps;
		const [channel, source, target, state] = await Promise.all([
			channelRepository.channelData.findUnique(params.threadId),
			channelRepository.channelData.findUnique(params.sourceParentId),
			channelRepository.channelData.findUnique(params.targetParentId),
			channelRepository.threads.getState(params.threadId),
		]);
		if (!channel || !source || !target || !state) throw new UnknownChannelError();
		if (
			!source.isThreadOnly() ||
			!target.isThreadOnly() ||
			channel.type !== ChannelTypes.PUBLIC_THREAD ||
			!channel.guildId ||
			channel.guildId !== source.guildId ||
			channel.guildId !== target.guildId ||
			state.guildId !== channel.guildId
		) {
			throw new InvalidChannelTypeError();
		}
		const [sourceConfig, targetConfig] = await Promise.all([
			channelRepository.threads.getParentConfig(state.guildId, source.id),
			channelRepository.threads.getParentConfig(state.guildId, target.id),
		]);
		// 目标论坛标签具有独立 ID；仅保留同 ID 或唯一同名的明确映射。
		const sourceTags = new Map((sourceConfig?.availableTags ?? []).map((tag) => [tag.id, tag.name]));
		const targetTags = targetConfig?.availableTags ?? [];
		const appliedTags =
			state.parentId === target.id
				? state.appliedTags
				: state.appliedTags.flatMap((id) => {
						if (targetTags.some((tag) => tag.id === id)) return [id];
						const matches = targetTags.filter((tag) => tag.name === sourceTags.get(id));
						// 不为完成移动静默丢弃原生标签；先由管理配置对应标签再重试。
						if (matches.length !== 1)
							throw InputValidationError.fromCode('applied_tags', ValidationErrorCodes.INVALID_FORMAT);
						return [matches[0]!.id];
					});
		const before = await loadThreadView(channelRepository, channel, state, source);
		await prepareIntegrationContentChange(params.threadId);
		const next = await new ThreadMoveRepository(channelRepository).move({...params, appliedTags});
		const updated = await channelRepository.channelData.findUnique(params.threadId);
		if (!updated) throw new UnknownChannelError();
		const after = await loadThreadView(channelRepository, updated, next, target);
		const members = await channelRepository.threads.listMembers(params.threadId, {limit: MAX_THREAD_MEMBERS});
		await dispatchThreadEvents(gatewayService, next.guildId, [threadUpdateEvent(after, members)]);
		await finishIntegrationContentChange(params.threadId);
		// 必须等待可靠任务入队，不能用尽力发送吞掉重建失败。
		await getWorkerService().addJob('syncThreadSearchDocument', {threadId: params.threadId.toString()});
		if (state.parentId !== target.id) {
			await guildAuditLogService.record({
				guildId: next.guildId,
				targetId: params.threadId,
				userId: params.userId,
				action: AuditLogActionType.THREAD_UPDATE,
				auditLogReason: params.auditLogReason,
				metadata: {type: channel.type.toString()},
				changes: guildAuditLogService.computeChanges(
					{...serializeThreadForAudit(before), parent_id: params.sourceParentId.toString()},
					{...serializeThreadForAudit(after), parent_id: params.targetParentId.toString()},
				),
			});
		}
		return after;
	}
}
