// SPDX-License-Identifier: AGPL-3.0-or-later

import {createHash} from 'node:crypto';
import type {ApiContext} from '@app/api/ApiContext';
import {createGuildID} from '@app/api/BrandedTypes';
import {assertNotBannedFromGuild} from '@app/api/guild/services/GuildBanChecks';
import {
	type GuildJoinParams,
	GuildJoinStateChangedError,
} from '@app/api/guild/services/member/GuildMemberOperationsService';
import {canJoinSingleCommunity} from '@app/api/instance/SingleCommunityService';
import {createRequestCache} from '@app/api/middleware/RequestCacheMiddleware';
import {RequestServices} from '@app/api/middleware/ServiceMiddleware';
import {getGuildRepository, getInstanceConfigRepository} from '@app/api/middleware/ServiceSingletons';
import {isAccountClosed} from '@app/api/user/UserHelpers';
import {IntegrationError} from '@app/integration/IntegrationError';
import type {DiscordBinding} from '@app/integration/IntegrationIdentityRepository';
import {IntegrationOperationRepository} from '@app/integration/IntegrationOperationRepository';
import {IdentityId} from '@app/integration/IntegrationSchemas';
import {JoinSourceTypes} from '@fluxer/constants/src/GuildConstants';
import {ResourceLockedError} from '@fluxer/errors/src/domains/core/ResourceLockedError';

interface JoinPlan {
	joined_at: string;
	last_left_at: string | null;
	already_member: boolean;
}

/** Only a first claim made by Forum can enroll an account. Ready logins never call this service. */
export class IntegrationGuildMembershipService {
	constructor(
		private readonly context: ApiContext,
		private readonly operations = new IntegrationOperationRepository(),
		private readonly guilds = getGuildRepository(),
		private readonly instance = getInstanceConfigRepository(),
		private readonly joinMember: (params: GuildJoinParams) => Promise<unknown> = (params) =>
			new RequestServices(context, null, params.requestCache).guildService.members.addUserToGuild(params),
	) {}

	async configuredTarget(): Promise<string> {
		const target = process.env.INTEGRATION_GUILD_ID;
		if (!IdentityId.safeParse(target).success)
			throw new IntegrationError('FORUM_GUILD_NOT_CONFIGURED', 'A valid Forum guild must be explicitly configured');
		const policy = await this.instance.getInstancePolicyConfig();
		if (policy.single_community_enabled && policy.single_community_guild_id !== target)
			throw new IntegrationError(
				'FORUM_GUILD_CONFIGURATION_CONFLICT',
				'Forum guild conflicts with the single community',
			);
		if (!(await this.guilds.findUnique(createGuildID(BigInt(target!)))))
			throw new IntegrationError('FORUM_GUILD_NOT_CONFIGURED', 'Configured Forum guild is unavailable');
		return target!;
	}

	async ensureForCreation(binding: DiscordBinding): Promise<void> {
		if (binding.creation_source !== 'forum' || !IdentityId.safeParse(binding.creation_guild_id).success)
			throw new IntegrationError('RESOURCE_NOT_ALLOWED', 'This account has no Forum creation enrollment');
		const guildId = createGuildID(BigInt(binding.creation_guild_id!));
		if ((await this.configuredTarget()) !== binding.creation_guild_id)
			throw new IntegrationError('FORUM_GUILD_CONFIGURATION_CONFLICT', 'Forum creation target changed');
		const fingerprint = createHash('sha256')
			.update(JSON.stringify([binding.discord_user_id, String(binding.user_id), binding.operation_id, String(guildId)]))
			.digest('hex');
		const operationId = `forum_guild_init_${fingerprint}`;
		const key = `integration:operation:${operationId}`;
		const lease = await this.context.services.cache.acquireLock(key, 120);
		if (!lease) throw new IntegrationError('BUSY', 'Forum enrollment is already executing', true);
		const requestCache = createRequestCache();
		try {
			let record = await this.operations.find(operationId);
			if (record && (record.fingerprint !== fingerprint || record.actor_id !== binding.user_id))
				throw new IntegrationError('OPERATION_CONFLICT', 'Forum enrollment belongs to another account');
			// A successful initial join remains successful after a later voluntary leave or moderation action.
			if (record?.result) return;
			const user = await this.context.services.users.findUnique(binding.user_id);
			if (!user || !canJoinSingleCommunity(user) || isAccountClosed(user))
				throw new IntegrationError('ACCOUNT_UNAVAILABLE', 'Account is unavailable for Forum enrollment');
			await assertNotBannedFromGuild(this.guilds, this.context.services.users, {userId: binding.user_id, guildId});
			if (!record) {
				const [member, metadata] = await Promise.all([
					this.guilds.getMember(guildId, binding.user_id),
					this.guilds.getMembershipMetadata(guildId, binding.user_id),
				]);
				const plan: JoinPlan = {
					joined_at: new Date().toISOString(),
					last_left_at: metadata?.last_left_at?.toISOString() ?? null,
					already_member: member !== null,
				};
				record = await this.operations.allocate({
					operation_id: operationId,
					fingerprint,
					actor_id: binding.user_id,
					payload: JSON.stringify(plan),
					result: null,
				});
			}
			const plan = JSON.parse(record.payload) as JoinPlan;
			if (plan.already_member && !(await this.guilds.getMember(guildId, binding.user_id)))
				throw new IntegrationError('MEMBERSHIP_CHANGED', 'Existing membership was removed during Forum enrollment');
			if (!plan.already_member) {
				if (!(await this.context.services.cache.extendLock(key, lease, 120)))
					throw new IntegrationError('BUSY', 'Forum enrollment lease expired', true);
				await this.joinMember({
					userId: binding.user_id,
					guildId,
					requestCache,
					sendJoinMessage: false,
					joinSourceType: JoinSourceTypes.ADMIN_FORCE_ADD,
					recovery: {joinedAt: new Date(plan.joined_at), lastLeftAt: plan.last_left_at},
				});
			}
			if (!(await this.context.services.cache.extendLock(key, lease, 120)))
				throw new IntegrationError('BUSY', 'Forum enrollment lease expired', true);
			await this.operations.completeOnce(operationId, {guild_id: String(guildId), user_id: String(binding.user_id)});
		} catch (error) {
			if (error instanceof GuildJoinStateChangedError)
				throw new IntegrationError('MEMBERSHIP_CHANGED', 'Membership changed during Forum enrollment');
			if (error instanceof ResourceLockedError)
				throw new IntegrationError('BUSY', 'Guild membership is being changed', true);
			throw error;
		} finally {
			requestCache.clear();
			await this.context.services.cache.releaseLock(key, lease);
		}
	}
}
