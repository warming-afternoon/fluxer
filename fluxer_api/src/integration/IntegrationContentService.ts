// SPDX-License-Identifier: AGPL-3.0-or-later

import {createHash} from 'node:crypto';
import type {ApiContext} from '@app/api/ApiContext';
import {createChannelID, createGuildID, createMessageID, createUserID} from '@app/api/BrandedTypes';
import {ChannelRepository} from '@app/api/channel/ChannelRepository';
import {ThreadMoveService} from '@app/api/channel/services/thread/ThreadMoveService';
import {ThreadPolicyProjectionService} from '@app/api/channel/services/thread/ThreadPolicyProjectionService';
import {
	ThreadPolicyRepository,
	ThreadPolicyVersionConflictError,
} from '@app/api/channel/services/thread/ThreadPolicyRepository';
import {ThreadPolicyService} from '@app/api/channel/services/thread/ThreadPolicyService';
import {createRequestCache} from '@app/api/middleware/RequestCacheMiddleware';
import {RequestServices} from '@app/api/middleware/ServiceMiddleware';
import {getGuildAuditLogService, getGuildRepository, getStorageService} from '@app/api/middleware/ServiceSingletons';
import {isAccountClosed, isTemporarilyBanned} from '@app/api/user/UserHelpers';
import {IntegrationAttachmentManifest} from '@app/integration/IntegrationAttachmentManifest';
import {withIntegrationAttachmentOperation} from '@app/integration/IntegrationAttachmentOperation';
import {prepareIntegrationContentChange} from '@app/integration/IntegrationContentHooks';
import {IntegrationError} from '@app/integration/IntegrationError';
import {IntegrationOperationRepository} from '@app/integration/IntegrationOperationRepository';
import {IntegrationSchemas} from '@app/integration/IntegrationSchemas';
import {UserFlags} from '@fluxer/constants/src/UserConstants';
import {FluxerError} from '@fluxer/errors/src/FluxerError';

interface ServiceRequest {
	/** 永久幂等标识 */
	operation_id: string;

	/** 请求传输标识，不参与操作指纹 */
	request_id: string;

	/** Forum 完成业务授权后的真实操作人 */
	actor_user_id: string;

	/** 允许的服务器 */
	guild_id: string;
}

export class IntegrationContentService {
	/** 内容操作只通过独立受信 Forum subject 调用，不开放任意服务方法 */
	constructor(
		private readonly context: ApiContext,
		private readonly operations = new IntegrationOperationRepository(),
	) {}

	/** 校验固定论坛边界，跨服务器和非允许论坛一律拒绝 */
	private allowed(guildId: string, channelId: string): void {
		const forums = (process.env.INTEGRATION_FORUM_CHANNEL_IDS ?? '').split(',').filter(Boolean);
		if (process.env.INTEGRATION_GUILD_ID !== guildId || new Set(forums).size !== 4 || !forums.includes(channelId))
			throw new IntegrationError('RESOURCE_NOT_ALLOWED', 'Resource is outside configured Forum scope');
	}

	/** 所有服务操作重新读取原生账号和成员状态，Forum 无权代已停用用户操作 */
	private async actor(request: ServiceRequest) {
		const id = createUserID(BigInt(request.actor_user_id));
		const user = await this.context.services.users.findUnique(id);
		if (
			!user ||
			user.isBot ||
			isAccountClosed(user) ||
			isTemporarilyBanned(user) ||
			(user.flags & (UserFlags.DISABLED | UserFlags.SELF_DELETED)) !== 0n ||
			user.traits.has('registration_pending_approval') ||
			user.traits.has('registration_rejected')
		)
			throw new IntegrationError('ACCOUNT_UNAVAILABLE', 'Actor account is unavailable');
		if (!(await getGuildRepository().getMember(createGuildID(BigInt(request.guild_id)), id)))
			throw new IntegrationError('RESOURCE_NOT_ALLOWED', 'Actor is not a guild member');
		return user;
	}

	/** 永久计划先于副作用，重试复用结果和原资源位置 */
	private async run<P, R>(
		subject: string,
		request: ServiceRequest,
		resource: string,
		prepare: () => Promise<P>,
		apply: (plan: P) => Promise<R>,
	): Promise<R> {
		const fingerprint = createHash('sha256')
			.update(JSON.stringify({subject, ...request, request_id: undefined}))
			.digest('hex');
		const key = `integration:operation:${request.operation_id}`;
		const lease = await this.context.services.cache.acquireLock(key, 120);
		if (!lease) throw new IntegrationError('BUSY', 'Operation is already executing', true);
		let hasPersistedPlan = false;
		let resultPersisted = false;
		let preparedPlan: P | null = null;
		try {
			let record = await this.operations.find(request.operation_id);
			if (record && (record.fingerprint !== fingerprint || record.actor_id !== BigInt(request.actor_user_id)))
				throw new IntegrationError('OPERATION_CONFLICT', 'Operation belongs to another immutable request');
			if (record?.result) {
				resultPersisted = true;
				await this.operations.releaseResource(resource, request.operation_id);
				const result = JSON.parse(record.result);
				if (result?.__integration_error)
					throw new IntegrationError(result.__integration_error.code, result.__integration_error.message);
				await this.completeInitialization(subject, request, result);
				await this.operations.releaseResource(resource, request.operation_id);
				return result as R;
			}
			await this.operations.lockResource(resource, request.operation_id);
			if (!record)
				record = await this.operations.allocate({
					operation_id: request.operation_id,
					fingerprint,
					actor_id: BigInt(request.actor_user_id),
					payload: JSON.stringify({operation_request: request, operation_plan: await prepare()}),
					result: null,
				});
			hasPersistedPlan = true;
			const saved = JSON.parse(record.payload);
			preparedPlan = (saved.operation_plan ?? saved) as P;
			const result = await apply(preparedPlan);
			if (!(await this.context.services.cache.extendLock(key, lease, 120)))
				throw new IntegrationError('BUSY', 'Operation lease expired; retry the same operation', true);
			await this.operations.complete(request.operation_id, result);
			resultPersisted = true;
			await this.completeInitialization(subject, request, result);
			await this.operations.releaseResource(resource, request.operation_id);
			return result;
		} catch (error) {
			// 未保存计划时还没有业务副作用，释放占用避免无效请求阻塞资源。
			if (!hasPersistedPlan) await this.operations.releaseResource(resource, request.operation_id);
			let terminal: IntegrationError | null = null;
			if (error instanceof IntegrationError && !error.retryable) {
				terminal = error;
			} else if (error instanceof FluxerError && error.status >= 400 && error.status < 500 && error.status !== 429) {
				terminal = new IntegrationError(error.code, error.code);
			}
			if (hasPersistedPlan && terminal && !resultPersisted) {
				if (subject === 'rpc.content.v1.thread.create_service') {
					const threadId = (preparedPlan as {thread_id?: string} | null)?.thread_id;
					if (threadId) {
						await new IntegrationAttachmentManifest(this.operations).discard(
							request.operation_id,
							createChannelID(BigInt(threadId)),
							threadId,
							getStorageService(),
						);
					}
				}
				await this.operations.complete(request.operation_id, {
					__integration_error: {code: terminal.code, message: terminal.message},
				});
				await this.operations.releaseResource(resource, request.operation_id);
				throw terminal;
			}
			throw error;
		} finally {
			await this.context.services.cache.releaseLock(key, lease);
		}
	}

	/** 默认主帖也在创建成功持久化前保持初始化锁，只有完成结果可释放自己的来源 */
	private async completeInitialization(subject: string, request: ServiceRequest, result: unknown): Promise<void> {
		if (
			subject !== 'rpc.content.v1.thread.create_service' ||
			process.env.FLUXER_THREAD_POLICY_ENABLED !== 'true' ||
			(request as ServiceRequest & {defer_open?: boolean}).defer_open
		)
			return;
		const threadId = (result as {thread_id?: string}).thread_id;
		if (!threadId) throw new IntegrationError('OPERATION_CONFLICT', 'Completed creation has no native thread');
		await new ThreadPolicyRepository().set(createChannelID(BigInt(threadId)), 0n, {
			source: 'forum_initializing',
			kind: 'lock',
			active: false,
			version: 1,
			expires_at: null,
		});
		await new ThreadPolicyProjectionService(this.context).project(createChannelID(BigInt(threadId)));
	}

	/** 将明确枚举的内容 RPC 适配到原生业务层 */
	async dispatch(subject: string, input: unknown): Promise<unknown> {
		const cache = createRequestCache();
		const services = new RequestServices(this.context, null, cache);
		switch (subject) {
			case 'rpc.content.v1.thread.update_service': {
				const request = IntegrationSchemas[subject].parse(input);
				const user = await this.actor(request);
				return this.run(
					subject,
					request,
					`thread:${request.thread_id}`,
					async () => {
						const state = await services.channelRepository.threads.getState(createChannelID(BigInt(request.thread_id)));
						if (!state || state.guildId.toString() !== request.guild_id)
							throw new IntegrationError('RESOURCE_NOT_ALLOWED', 'Thread is outside configured scope');
						this.allowed(request.guild_id, state.parentId.toString());
						return {channel_id: state.parentId.toString()};
					},
					async (plan) => {
						const channelId = createChannelID(BigInt(request.thread_id));
						const auth = await services.channelService.channelData.auth.getChannelAuthenticated({
							userId: user.id,
							channelId,
							viewer: {kind: 'user', userId: user.id, bot: false, capable: true},
							skipNsfwValidation: true,
						});
						const data = {
							...(request.name === undefined ? {} : {name: request.name}),
							...(request.archived === undefined ? {} : {archived: request.archived}),
						};
						await services.channelService.channelData.threadModify.updateThread({
							authChannel: auth,
							userId: user.id,
							data,
							auditLogReason: `Forum operation ${request.operation_id}`,
							delegatedForumFields: true,
						});
						const state = await services.channelRepository.threads.getState(channelId);
						return {
							guild_id: request.guild_id,
							channel_id: plan.channel_id,
							thread_id: request.thread_id,
							state_version: state!.stateVersion,
							event_id: request.operation_id,
						};
					},
				);
			}
			case 'rpc.content.v1.thread.move_service': {
				const request = IntegrationSchemas[subject].parse(input);
				const user = await this.actor(request);
				this.allowed(request.guild_id, request.target_channel_id);
				return this.run(
					subject,
					request,
					`thread:${request.thread_id}`,
					async () => {
						const state = await services.channelRepository.threads.getState(createChannelID(BigInt(request.thread_id)));
						if (!state || state.guildId.toString() !== request.guild_id)
							throw new IntegrationError('RESOURCE_NOT_ALLOWED', 'Thread is outside configured scope');
						this.allowed(request.guild_id, state.parentId.toString());
						return {source_channel_id: state.parentId.toString()};
					},
					async (plan) => {
						this.allowed(request.guild_id, plan.source_channel_id);
						const view = await new ThreadMoveService({
							channelRepository: new ChannelRepository(),
							gatewayService: this.context.services.gateway,
							guildAuditLogService: getGuildAuditLogService(),
						}).move({
							threadId: createChannelID(BigInt(request.thread_id)),
							sourceParentId: createChannelID(BigInt(plan.source_channel_id)),
							targetParentId: createChannelID(BigInt(request.target_channel_id)),
							userId: user.id,
							auditLogReason: `Forum operation ${request.operation_id}`,
						});
						return {
							guild_id: request.guild_id,
							thread_id: request.thread_id,
							source_channel_id: plan.source_channel_id,
							channel_id: request.target_channel_id,
							target_channel_id: request.target_channel_id,
							state_version: view.state.stateVersion,
							event_id: request.operation_id,
						};
					},
				);
			}
			case 'rpc.content.v1.thread.create_service': {
				const request = IntegrationSchemas[subject].parse(input);
				const user = await this.actor(request);
				this.allowed(request.guild_id, request.channel_id);
				return this.run(
					subject,
					request,
					`create:${request.operation_id}`,
					async () => ({thread_id: (await this.context.services.snowflake.generate()).toString()}),
					async (plan) => {
						if (request.parent_thread_id) {
							const parent = await services.channelRepository.threads.getState(
								createChannelID(BigInt(request.parent_thread_id)),
							);
							if (!parent || parent.guildId.toString() !== request.guild_id)
								throw new IntegrationError('RESOURCE_NOT_ALLOWED', 'Logical parent belongs to another guild');
							this.allowed(request.guild_id, parent.parentId.toString());
							await new ThreadPolicyService().assertAllowed(parent.threadId, user.id, 'create');
						}
						const viewer = {kind: 'user' as const, userId: user.id, bot: false, capable: true};
						const parentAuth = await services.channelService.channelData.auth.getChannelAuthenticated({
							userId: user.id,
							channelId: createChannelID(BigInt(request.channel_id)),
							viewer,
						});
						if (parentAuth.channel.guildId?.toString() !== request.guild_id)
							throw new IntegrationError('RESOURCE_NOT_ALLOWED', 'Forum belongs to another guild');
						if (request.initial_policies?.length) {
							if (process.env.FLUXER_THREAD_POLICY_ENABLED !== 'true')
								throw new IntegrationError('UNAVAILABLE', 'Initial thread policies are not enabled', true);
							for (const policy of request.initial_policies) {
								try {
									await new ThreadPolicyRepository().set(
										createChannelID(BigInt(plan.thread_id)),
										BigInt(policy.target_user_id),
										{
											source: policy.source,
											kind: 'deny_send',
											active: policy.active,
											version: policy.policy_version,
											expires_at: policy.expires_at ? new Date(policy.expires_at) : null,
										},
									);
								} catch (error) {
									if (error instanceof ThreadPolicyVersionConflictError)
										throw new IntegrationError('OPERATION_CONFLICT', error.message);
									throw error;
								}
							}
							await new ThreadPolicyService().assertAllowed(
								createChannelID(BigInt(plan.thread_id)),
								user.id,
								'create',
								{initializingStarter: true},
							);
						}
						if (request.defer_open || process.env.FLUXER_THREAD_POLICY_ENABLED === 'true') {
							if (process.env.FLUXER_THREAD_POLICY_ENABLED !== 'true')
								throw new IntegrationError('UNAVAILABLE', 'Initialization policies are not enabled', true);
							await new ThreadPolicyRepository().set(createChannelID(BigInt(plan.thread_id)), 0n, {
								source: 'forum_initializing',
								kind: 'lock',
								active: true,
								version: 0,
								expires_at: null,
							});
						}
						await prepareIntegrationContentChange(createChannelID(BigInt(plan.thread_id)), {
							guild_id: request.guild_id,
							channel_id: request.channel_id,
							thread_id: plan.thread_id,
							creation_operation_id: request.operation_id,
						});
						await withIntegrationAttachmentOperation(
							request.operation_id,
							() =>
								services.threadService.creation.createForumPost({
									viewer,
									user,
									parentAuth,
									body: {
										name: request.name,
										message: {
											content: request.content,
											allowed_mentions: {parse: [], replied_user: false},
											attachments: request.attachments?.map((attachment) => ({
												...attachment,
												title: null,
												description: null,
												flags: 0,
											})),
										},
									},
									requestCache: cache,
									auditLogReason: `Forum operation ${request.operation_id}`,
									preparedThreadId: createChannelID(BigInt(plan.thread_id)),
									deferOpen: request.defer_open || process.env.FLUXER_THREAD_POLICY_ENABLED === 'true',
								}),
							{channelId: plan.thread_id, messageId: plan.thread_id},
						);
						const state = await services.channelRepository.threads.getState(createChannelID(BigInt(plan.thread_id)));
						return {
							guild_id: request.guild_id,
							channel_id: request.channel_id,
							thread_id: plan.thread_id,
							message_id: plan.thread_id,
							deferred_open: request.defer_open === true,
							state_version: state!.stateVersion,
							event_id: request.operation_id,
						};
					},
				);
			}
			case 'rpc.content.v1.thread.policy_service': {
				const request = IntegrationSchemas[subject].parse(input);
				await this.actor(request);
				if (process.env.FLUXER_THREAD_POLICY_ENABLED !== 'true')
					throw new IntegrationError('UNAVAILABLE', 'Thread policies are not enabled', true);
				return this.run(
					subject,
					request,
					`thread:${request.thread_id}`,
					async () => {
						const state = await services.channelRepository.threads.getState(createChannelID(BigInt(request.thread_id)));
						if (!state || state.guildId.toString() !== request.guild_id)
							throw new IntegrationError('RESOURCE_NOT_ALLOWED', 'Thread is outside configured scope');
						this.allowed(request.guild_id, state.parentId.toString());
						return {channel_id: state.parentId.toString()};
					},
					async (plan) => {
						try {
							await new ThreadPolicyRepository().set(
								createChannelID(BigInt(request.thread_id)),
								request.kind === 'lock' ? 0n : BigInt(request.target_user_id!),
								{
									source: request.source,
									kind: request.kind,
									active: request.active,
									version: request.policy_version,
									expires_at: request.expires_at ? new Date(request.expires_at) : null,
								},
							);
						} catch (error) {
							if (error instanceof ThreadPolicyVersionConflictError)
								throw new IntegrationError('OPERATION_CONFLICT', error.message);
							throw error;
						}
						const projected =
							request.kind === 'lock'
								? await new ThreadPolicyProjectionService(this.context).project(
										createChannelID(BigInt(request.thread_id)),
									)
								: null;
						return {
							guild_id: request.guild_id,
							channel_id: plan.channel_id,
							thread_id: request.thread_id,
							source: request.source,
							policy_version: request.policy_version,
							...(projected
								? {state_version: projected.stateVersion, archived: projected.archived, locked: projected.locked}
								: {}),
							event_id: request.operation_id,
						};
					},
				);
			}
			case 'rpc.content.v1.starter.edit_service': {
				const request = IntegrationSchemas[subject].parse(input);
				const user = await this.actor(request);
				return this.run(
					subject,
					request,
					`thread:${request.thread_id}`,
					async () => {
						const state = await services.channelRepository.threads.getState(createChannelID(BigInt(request.thread_id)));
						if (!state?.hasStarter || state.guildId.toString() !== request.guild_id)
							throw new IntegrationError('RESOURCE_NOT_ALLOWED', 'Thread is outside configured scope');
						this.allowed(request.guild_id, state.parentId.toString());
						const original = await services.channelRepository.messages.getMessage(
							state.threadId,
							createMessageID(BigInt(state.threadId)),
						);
						if (!original) throw new IntegrationError('RESOURCE_NOT_ALLOWED', 'Starter message is unavailable');
						for (const attachment of request.attachments ?? []) {
							if (
								!('upload_filename' in attachment) &&
								!original.attachments.some((existing) => existing.id.toString() === attachment.id)
							)
								throw new IntegrationError(
									'RESOURCE_NOT_ALLOWED',
									'Attachment reference is outside the target starter',
								);
						}
						return {channel_id: state.parentId.toString(), message_version: original.version};
					},
					async (plan) => {
						const current = await services.channelRepository.messages.getMessage(
							createChannelID(BigInt(request.thread_id)),
							createMessageID(BigInt(request.thread_id)),
						);
						if (!current) throw new IntegrationError('RESOURCE_NOT_ALLOWED', 'Starter message is unavailable');
						if (current.version !== plan.message_version) {
							const prepared = request.attachments?.some((attachment) => 'upload_filename' in attachment)
								? await new IntegrationAttachmentManifest().result(
										request.operation_id,
										request.thread_id,
										request.thread_id,
									)
								: null;
							let uploadIndex = 0;
							const desiredIds = request.attachments?.map((attachment) =>
								'upload_filename' in attachment
									? prepared?.attachments[uploadIndex++]?.attachment_id.toString()
									: attachment.id,
							);
							const attachmentsMatch =
								desiredIds === undefined ||
								(desiredIds.every((id) => id !== undefined) &&
									JSON.stringify(desiredIds) ===
										JSON.stringify(current.attachments.map((attachment) => attachment.id.toString())));
							if ((request.content !== undefined && current.content !== request.content) || !attachmentsMatch)
								throw new IntegrationError('MESSAGE_VERSION_CONFLICT', 'A newer body edit superseded this operation');
							return {
								guild_id: request.guild_id,
								channel_id: plan.channel_id,
								thread_id: request.thread_id,
								message_id: current.id.toString(),
								event_id: request.operation_id,
							};
						}
						const message = await withIntegrationAttachmentOperation(
							request.operation_id,
							() =>
								services.messageRequestService.editMessage({
									userId: user.id,
									viewer: {kind: 'user', userId: user.id, bot: false, capable: true},
									channelId: createChannelID(BigInt(request.thread_id)),
									messageId: createMessageID(BigInt(request.thread_id)),
									data: {
										content: request.content ?? current.content ?? '',
										allowed_mentions: {parse: [], replied_user: false},
										...(request.attachments === undefined
											? {}
											: {
													attachments: request.attachments.map((attachment) =>
														'upload_filename' in attachment
															? {...attachment, title: null, description: null, flags: 0}
															: {id: BigInt(attachment.id), flags: 0},
													),
												}),
									},
									requestCache: cache,
									expectedVersion: plan.message_version,
								}),
							{channelId: request.thread_id, messageId: request.thread_id},
						);
						return {
							guild_id: request.guild_id,
							channel_id: plan.channel_id,
							thread_id: request.thread_id,
							message_id: message.id,
							event_id: request.operation_id,
						};
					},
				);
			}
			case 'rpc.content.v1.thread.read_service': {
				const request = IntegrationSchemas[subject].parse(input);
				const user = await this.actor(request);
				const state = await services.channelRepository.threads.getState(createChannelID(BigInt(request.thread_id)));
				if (!state || state.guildId.toString() !== request.guild_id)
					throw new IntegrationError('RESOURCE_NOT_ALLOWED', 'Thread is outside configured scope');
				this.allowed(request.guild_id, state.parentId.toString());
				const message = await services.messageRequestService.getMessage({
					userId: user.id,
					viewer: {kind: 'user', userId: user.id, bot: false, capable: true},
					channelId: createChannelID(BigInt(request.thread_id)),
					messageId: createMessageID(BigInt(request.thread_id)),
					requestCache: cache,
				});
				return {
					guild_id: request.guild_id,
					channel_id: state.parentId.toString(),
					thread_id: request.thread_id,
					state_version: state.stateVersion,
					archived: state.archived,
					locked: state.locked,
					message,
				};
			}
			default:
				throw new IntegrationError('UNKNOWN_METHOD', 'Unknown content method');
		}
	}
}
