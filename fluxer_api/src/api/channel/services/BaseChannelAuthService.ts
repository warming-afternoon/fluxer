// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ChannelID, GuildID, UserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import type {ChannelRepository} from '@app/api/channel/ChannelRepository';
import type {AuthenticatedChannel, AuthenticatedThread} from '@app/api/channel/services/AuthenticatedChannel';
import {DMPermissionValidator} from '@app/api/channel/services/DMPermissionValidator';
import {
	ensurePersonalNotesChannelExists,
	isPersonalNotesChannelId,
} from '@app/api/channel/services/PersonalNotesChannelRepair';
import {assertThreadAllowed} from '@app/api/channel/services/thread/ThreadDenials';
import {
	type ContentWarningChannelLike,
	channelResponseToContentWarningView,
	channelToContentWarningView,
	computeEffectiveChannelNsfw,
	guildResponseToContentWarningView,
} from '@app/api/channel/utils/EffectiveContentWarning';
import {SYSTEM_USER_ID} from '@app/api/constants/Core';
import {
	THREAD_CHANNEL_TYPES,
	THREAD_FEATURE_CHANNEL_TYPES,
	THREAD_ONLY_CHANNEL_TYPES,
	THREAD_PARENT_CHANNEL_TYPES,
	type ThreadViewer,
	viewerActive,
} from '@app/api/experiment/ChannelThreadsGate';
import {isGuildMemberTimedOut} from '@app/api/guild/GuildModel';
import type {GuildRepository} from '@app/api/guild/repositories/GuildRepository';
import {createGuildMfaEnforcer} from '@app/api/guild/services/GuildMfaEnforcement';
import type {GuildChannelAuthContext, IGatewayService} from '@app/api/infrastructure/IGatewayService';
import type {Channel} from '@app/api/models/Channel';
import type {GuildMember} from '@app/api/models/GuildMember';
import type {User} from '@app/api/models/User';
import type {UserRepository} from '@app/api/user/repositories/UserRepository';
import {canUserAccessNsfwContent} from '@app/api/utils/AgeUtils';
import {ChannelTypes, Permissions} from '@fluxer/constants/src/ChannelConstants';
import {
	canViewThread,
	isThreadModerator,
	threadViewPermissions,
	withImplicitThreadBits,
} from '@fluxer/constants/src/ThreadPermissionUtils';
import {CannotSendMessagesToUserError} from '@fluxer/errors/src/domains/channel/CannotSendMessagesToUserError';
import {UnknownChannelError} from '@fluxer/errors/src/domains/channel/UnknownChannelError';
import {AccessDeniedError} from '@fluxer/errors/src/domains/core/AccessDeniedError';
import {MissingPermissionsError} from '@fluxer/errors/src/domains/core/MissingPermissionsError';
import {UnknownGuildError} from '@fluxer/errors/src/domains/guild/UnknownGuildError';
import {NsfwContentRequiresAgeVerificationError} from '@fluxer/errors/src/domains/moderation/NsfwContentRequiresAgeVerificationError';
import {UnknownUserError} from '@fluxer/errors/src/domains/user/UnknownUserError';
import type {GuildMemberResponse} from '@fluxer/schema/src/domains/guild/GuildMemberSchemas';
import type {GuildResponse} from '@fluxer/schema/src/domains/guild/GuildResponseSchemas';

export interface ChannelAuthOptions {
	errorOnMissingGuild: 'unknown_channel' | 'missing_permissions';
	validateNsfw: boolean;
}

interface DMSendPermissionsByChannelParams {
	channel: Channel;
	userId: UserID;
}

interface DMSendPermissionsByChannelIdParams {
	channelId: ChannelID;
	userId: UserID;
}

type DMSendPermissionsParams = DMSendPermissionsByChannelParams | DMSendPermissionsByChannelIdParams;

export interface ThreadPermissionContext {
	guild: GuildResponse;
	member: GuildMemberResponse;
	parentCategory: GuildChannelAuthContext['parentChannel'];
	thread: AuthenticatedThread;
}

export abstract class BaseChannelAuthService {
	protected abstract readonly options: ChannelAuthOptions;
	protected dmPermissionValidator: DMPermissionValidator;

	constructor(
		protected channelRepository: ChannelRepository,
		protected userRepository: UserRepository,
		protected guildRepository: GuildRepository,
		protected gatewayService: IGatewayService,
	) {
		this.dmPermissionValidator = new DMPermissionValidator({
			userRepository: this.userRepository,
			guildRepository: this.guildRepository,
		});
	}

	async getChannelAuthenticated({
		userId,
		channelId,
		viewer,
		skipNsfwValidation,
	}: {
		userId: UserID;
		channelId: ChannelID;
		viewer: ThreadViewer;
		skipNsfwValidation?: boolean;
	}): Promise<AuthenticatedChannel> {
		if (isPersonalNotesChannelId({userId, channelId})) {
			const channel = await ensurePersonalNotesChannelExists({
				channelRepository: this.channelRepository.channelData,
				userId,
			});
			return this.getRealPersonalNotesChannelAuth({channel, userId});
		}
		const channel = await this.channelRepository.channelData.findUnique(channelId);
		if (!channel) throw new UnknownChannelError();
		if (
			THREAD_FEATURE_CHANNEL_TYPES.has(channel.type) &&
			(channel.guildId === null || !viewerActive(viewer, channel.guildId))
		) {
			throw new UnknownChannelError();
		}
		if (!channel.guildId) {
			const recipients = await this.userRepository.listUsers(Array.from(channel.recipientIds));
			return this.getDMChannelAuth({channel, recipients, userId});
		}
		return this.getGuildChannelAuth({channel, userId, skipNsfwValidation});
	}

	protected async getRealPersonalNotesChannelAuth({
		channel,
		userId,
	}: {
		channel: Channel;
		userId: UserID;
	}): Promise<AuthenticatedChannel> {
		if (!isPersonalNotesChannelId({userId, channelId: channel.id})) {
			throw new UnknownChannelError();
		}
		if (channel.type !== ChannelTypes.DM_PERSONAL_NOTES) {
			throw new UnknownChannelError();
		}
		return {
			channel,
			guild: null,
			member: null,
			hasPermission: async () => true,
			checkPermission: async () => {},
		};
	}

	protected async getDMChannelAuth({
		channel,
		recipients,
		userId,
	}: {
		channel: Channel;
		recipients: Array<User>;
		userId: UserID;
	}): Promise<AuthenticatedChannel> {
		if (userId === SYSTEM_USER_ID) {
			return {
				channel,
				guild: null,
				member: null,
				hasPermission: async () => true,
				checkPermission: async () => {},
			};
		}
		if (channel.type === ChannelTypes.DM && channel.ownerId != null && channel.ownerId !== userId) {
			throw new UnknownChannelError();
		}
		const isRecipient = recipients.some((recipient) => recipient.id === userId);
		if (!isRecipient) throw new UnknownChannelError();
		return {
			channel,
			guild: null,
			member: null,
			hasPermission: async () => true,
			checkPermission: async () => {},
		};
	}

	async validateDMSendPermissions(params: DMSendPermissionsParams): Promise<void> {
		const {userId} = params;
		const channel =
			'channel' in params ? params.channel : await this.channelRepository.channelData.findUnique(params.channelId);
		if (!channel) throw new UnknownChannelError();
		if (channel.type === ChannelTypes.GROUP_DM || channel.type === ChannelTypes.DM_PERSONAL_NOTES) {
			return;
		}
		const recipientIds = Array.from(channel.recipientIds).filter((id) => id !== userId);
		if (recipientIds.length !== 1) {
			throw new CannotSendMessagesToUserError();
		}
		await this.dmPermissionValidator.validate({senderId: userId, recipientId: recipientIds[0]});
	}

	/** 校验频道鉴权结果并保留成员、权限与内容分级约束。 */
	protected async getGuildChannelAuth({
		channel,
		userId,
		skipNsfwValidation,
	}: {
		channel: Channel;
		userId: UserID;
		skipNsfwValidation?: boolean;
	}): Promise<AuthenticatedChannel> {
		if (THREAD_CHANNEL_TYPES.has(channel.type)) {
			return this.getThreadChannelAuth({channel, userId, skipNsfwValidation});
		}
		const guildId = channel.guildId!;
		const combined = await this.fetchCombinedAuthorization({
			guildId,
			userId,
			channelId: this.parentLookupChannelId(channel),
			permissionTargetChannelId: channel.id,
			mode: 'channel',
		});
		const [authContextResult, guildMemberResult] = combined
			? [combined, combined.memberResult]
			: await Promise.all([
					this.fetchGuildAuthContextOrThrow({guildId, userId, channelId: this.parentLookupChannelId(channel)}),
					this.fetchGuildMemberOrThrow({guildId, userId}),
				]);
		if (!authContextResult) {
			this.throwGuildAccessError();
		}
		const guildDataResult = authContextResult.guild;
		if (!guildMemberResult.success || !guildMemberResult.memberData) {
			this.throwGuildAccessError();
		}
		const member = await this.fillMissingMemberTimeout({
			guildId,
			userId,
			memberData: guildMemberResult.memberData!,
		});
		const enforceGuildMfa = await createGuildMfaEnforcer({
			userRepository: this.userRepository,
			guildData: guildDataResult,
			userId,
		});
		const channelPermissions =
			combined?.permissions ??
			(await this.gatewayService.getUserPermissions({
				guildId,
				userId,
				channelId: channel.id,
			}));
		const hasPermission = async (permission: bigint): Promise<boolean> => {
			const allowed = (channelPermissions & permission) === permission;
			if (allowed) enforceGuildMfa(permission);
			return allowed;
		};
		const checkPermission = async (permission: bigint): Promise<void> => {
			const allowed = await hasPermission(permission);
			if (!allowed) throw new MissingPermissionsError();
		};
		await checkPermission(Permissions.VIEW_CHANNEL);
		const parentCategory = await this.getParentCategoryContentWarningView({
			channel,
			parentChannel: authContextResult.parentChannel,
		});
		const requiresAgeVerification = computeEffectiveChannelNsfw(
			channelToContentWarningView(channel),
			parentCategory,
			guildResponseToContentWarningView(guildDataResult),
		);
		if (
			this.options.validateNsfw &&
			!skipNsfwValidation &&
			(channel.type === ChannelTypes.GUILD_TEXT ||
				channel.type === ChannelTypes.GUILD_ANNOUNCEMENT ||
				channel.type === ChannelTypes.GUILD_VOICE ||
				channel.type === ChannelTypes.GUILD_LINK ||
				THREAD_ONLY_CHANNEL_TYPES.has(channel.type)) &&
			requiresAgeVerification
		) {
			const user = await this.userRepository.findUnique(userId);
			if (!user) throw new UnknownUserError();
			if (!canUserAccessNsfwContent(user)) {
				throw new NsfwContentRequiresAgeVerificationError();
			}
		}
		return {
			channel,
			guild: guildDataResult,
			member,
			hasPermission,
			checkPermission,
		};
	}

	/** 在父频道校验后重叠独立查询与授权，并保留原有错误优先级。 */
	async resolveThreadPermissionContext({
		thread,
		userId,
	}: {
		thread: Channel;
		userId: UserID;
	}): Promise<ThreadPermissionContext> {
		const guildId = thread.guildId;
		const parentId = thread.parentId;
		if (guildId === null || parentId === null) throw new UnknownChannelError();
		const parentPromise = this.channelRepository.channelData.findUnique(parentId);
		let readsFailed = false;
		// 立即观察授权成败，等待原有仓储读取与父频道、帖子状态校验后再返回授权错误。
		const combinedPromise =
			Config.combinedChannelAuthEnabled === true
				? parentPromise
						.then((parent) => {
							if (
								readsFailed ||
								!parent ||
								parent.guildId !== guildId ||
								!THREAD_PARENT_CHANNEL_TYPES.has(parent.type)
							) {
								return null;
							}
							return this.fetchCombinedAuthorization({
								guildId,
								userId,
								channelId: this.parentLookupChannelId(parent),
								permissionTargetChannelId: parent.id,
								mode: 'thread',
							});
						})
						.then(
							(value) => ({value}),
							(error: unknown) => ({error}),
						)
				: null;
		const reads = Promise.all([
			parentPromise,
			this.channelRepository.threads.getState(thread.id),
			this.channelRepository.threads.getMember(thread.id, userId),
			Config.combinedChannelAuthEnabled === true
				? Promise.resolve(null)
				: this.fetchGuildMemberOrThrow({guildId, userId}),
		]);
		const [parent, state, threadMember, guildMemberResult] = combinedPromise
			? await reads.catch(async (error: unknown) => {
					readsFailed = true;
					await combinedPromise;
					throw error;
				})
			: await reads;
		if (!parent || !state || parent.guildId !== guildId || !THREAD_PARENT_CHANNEL_TYPES.has(parent.type)) {
			await combinedPromise;
			throw new UnknownChannelError();
		}
		const combinedOutcome = await combinedPromise;
		if (combinedOutcome && 'error' in combinedOutcome) throw combinedOutcome.error;
		const combined = combinedOutcome?.value ?? null;
		const resolvedMember = combined?.memberResult ?? guildMemberResult;
		if (!resolvedMember?.success || !resolvedMember.memberData) this.throwGuildAccessError();
		const [authContextResult, parentPermissions] = combined
			? [combined, combined.permissions]
			: await Promise.all([
					this.fetchGuildAuthContextOrThrow({guildId, userId, channelId: this.parentLookupChannelId(parent)}),
					this.gatewayService.getUserPermissions({guildId, userId, channelId: parent.id}),
				]);
		if (!authContextResult) {
			this.throwGuildAccessError();
		}
		const member = await this.fillMissingMemberTimeout({guildId, userId, memberData: resolvedMember.memberData});
		const guild = authContextResult.guild;
		const enforceMfa = await createGuildMfaEnforcer({userRepository: this.userRepository, guildData: guild, userId});
		const isOwner = guild.owner_id === userId.toString();
		const timedOut = isGuildMemberTimedOut(member);
		const actor = {
			permissions: parentPermissions,
			isOwner,
			timedOut,
			thread: {
				type: state.type,
				archived: state.archived,
				locked: state.locked,
				invitable: state.invitable ?? true,
			},
			isThreadOwner: thread.ownerId === userId,
			isMember: threadMember !== null,
		};
		return {
			guild,
			member,
			parentCategory: authContextResult.parentChannel,
			thread: {
				state,
				parent,
				member: threadMember,
				parentPermissions,
				actor,
				isModerator: isThreadModerator(withImplicitThreadBits(parentPermissions), {isOwner, timedOut}),
				enforceMfa,
			},
		};
	}

	protected async getThreadChannelAuth({
		channel,
		userId,
		skipNsfwValidation,
	}: {
		channel: Channel;
		userId: UserID;
		skipNsfwValidation?: boolean;
	}): Promise<AuthenticatedChannel> {
		const context = await this.resolveThreadPermissionContext({thread: channel, userId});
		const {guild, member, thread} = context;
		assertThreadAllowed(canViewThread(thread.actor));
		const permissions = threadViewPermissions(thread.parentPermissions);
		const hasPermission = async (permission: bigint): Promise<boolean> => {
			const allowed = (permissions & permission) === permission;
			if (allowed) thread.enforceMfa(permission);
			return allowed;
		};
		const checkPermission = async (permission: bigint): Promise<void> => {
			if (!(await hasPermission(permission))) throw new MissingPermissionsError();
		};
		if (this.options.validateNsfw && !skipNsfwValidation && THREAD_PARENT_CHANNEL_TYPES.has(thread.parent.type)) {
			const parentCategory = await this.getParentCategoryContentWarningView({
				channel: thread.parent,
				parentChannel: context.parentCategory,
			});
			const requiresAgeVerification = computeEffectiveChannelNsfw(
				channelToContentWarningView(thread.parent),
				parentCategory,
				guildResponseToContentWarningView(guild),
			);
			if (requiresAgeVerification) {
				const user = await this.userRepository.findUnique(userId);
				if (!user) throw new UnknownUserError();
				if (!canUserAccessNsfwContent(user)) {
					throw new NsfwContentRequiresAgeVerificationError();
				}
			}
		}
		return {channel, guild, member, hasPermission, checkPermission, thread};
	}

	/** 读取合并授权结果并保留网关错误映射，关闭时沿用旧链路。 */
	private async fetchCombinedAuthorization(params: {
		/** 授权目标公会。 */
		guildId: GuildID;

		/** 请求授权的用户。 */
		userId: UserID;

		/** 内容分级判断使用的上下文频道。 */
		channelId?: ChannelID;

		/** 实际计算权限的目标频道。 */
		permissionTargetChannelId: ChannelID;

		/** 普通频道或帖子授权模式。 */
		mode: 'channel' | 'thread';
	}) {
		if (Config.combinedChannelAuthEnabled !== true) return null;
		try {
			return await this.gatewayService.getGuildChannelAuthorization(params);
		} catch (error) {
			await this.handleGuildAccessError(error, params.guildId);
			throw error;
		}
	}

	private parentLookupChannelId(channel: Channel): ChannelID | undefined {
		if (!channel.parentId || channel.type === ChannelTypes.GUILD_CATEGORY) {
			return undefined;
		}
		return channel.parentId;
	}

	private async getParentCategoryContentWarningView({
		channel,
		parentChannel,
	}: {
		channel: Channel;
		parentChannel: GuildChannelAuthContext['parentChannel'];
	}): Promise<ContentWarningChannelLike | null> {
		if (!channel.parentId || channel.type === ChannelTypes.GUILD_CATEGORY) {
			return null;
		}
		if (parentChannel) {
			return channelResponseToContentWarningView(parentChannel);
		}
		const parentCategory = await this.channelRepository.channelData.findUnique(channel.parentId);
		return parentCategory ? channelToContentWarningView(parentCategory) : null;
	}

	protected throwGuildAccessError(): never {
		if (this.options.errorOnMissingGuild === 'missing_permissions') {
			throw new MissingPermissionsError();
		}
		throw new UnknownChannelError();
	}

	private async fetchGuildAuthContextOrThrow(params: {
		guildId: GuildID;
		userId: UserID;
		channelId?: ChannelID;
	}): Promise<GuildChannelAuthContext | null> {
		const {guildId, userId, channelId} = params;
		try {
			return await this.gatewayService.getGuildAuthContext({guildId, userId, channelId});
		} catch (error) {
			await this.handleGuildAccessError(error, guildId);
			return null;
		}
	}

	private async fetchGuildMemberOrThrow(params: {guildId: GuildID; userId: UserID}): Promise<{
		success: boolean;
		memberData?: GuildMemberResponse;
	}> {
		try {
			return await this.gatewayService.getGuildMember(params);
		} catch (error) {
			await this.handleGuildAccessError(error, params.guildId);
			throw error;
		}
	}

	private async handleGuildAccessError(error: unknown, guildId: GuildID): Promise<void> {
		if (error instanceof UnknownGuildError) {
			if (await this.guildExists(guildId)) {
				throw new AccessDeniedError();
			}
			throw new UnknownGuildError();
		}
		throw error;
	}

	private async guildExists(guildId: GuildID): Promise<boolean> {
		const guild = await this.guildRepository.findUnique(guildId);
		return guild !== null;
	}

	private async fillMissingMemberTimeout({
		guildId,
		userId,
		memberData,
	}: {
		guildId: GuildID;
		userId: UserID;
		memberData: GuildMemberResponse;
	}): Promise<GuildMemberResponse> {
		if (memberData.communication_disabled_until !== undefined) {
			return memberData;
		}
		const persistedMember = await this.guildRepository.getMember(guildId, userId);
		if (!persistedMember) {
			this.throwGuildAccessError();
		}
		return {
			...memberData,
			communication_disabled_until: this.formatCommunicationDisabledUntil(persistedMember),
		};
	}

	private formatCommunicationDisabledUntil(member: GuildMember): string | null {
		return member.communicationDisabledUntil?.toISOString() ?? null;
	}
}
