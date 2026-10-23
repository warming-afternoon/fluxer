// SPDX-License-Identifier: AGPL-3.0-or-later

import {type ChannelID, createUserID, type UserID} from '@app/api/BrandedTypes';
import type {AuthenticatedChannel} from '@app/api/channel/services/AuthenticatedChannel';
import {assertThreadAllowed} from '@app/api/channel/services/thread/ThreadDenials';
import {filterThreadDiscoveryStates} from '@app/api/channel/services/thread/ThreadDiscoveryAccess';
import {mapThreadMemberToResponse, mapThreadToResponse} from '@app/api/channel/services/thread/ThreadMappers';
import type {ThreadServiceContext} from '@app/api/channel/services/thread/ThreadServiceContext';
import {loadThreadViews} from '@app/api/channel/services/thread/ThreadViews';
import {enqueueThreadSearchBackfill} from '@app/api/channel/threads/ThreadJobs';
import type {ThreadViewer} from '@app/api/experiment/ChannelThreadsGate';
import {mapGuildMemberToResponse} from '@app/api/guild/GuildModel';
import type {RequestCache} from '@app/api/middleware/RequestCacheMiddleware';
import {getThreadSearchService} from '@app/api/SearchFactory';
import {
	searchHitThreadIds,
	searchThreadDocuments,
	threadSearchCursor,
} from '@app/api/search/thread/ThreadSearchService';
import {Permissions} from '@fluxer/constants/src/ChannelConstants';
import {
	ForumTagSettings,
	THREAD_ONLY_CHANNEL_TYPES,
	THREAD_PARENT_CHANNEL_TYPES,
} from '@fluxer/constants/src/ThreadConstants';
import {
	canListArchivedThreads,
	isThreadModerator,
	withImplicitThreadBits,
} from '@fluxer/constants/src/ThreadPermissionUtils';
import {InvalidChannelTypeError} from '@fluxer/errors/src/domains/channel/InvalidChannelTypeError';
import {SearchIndexNotReadyError} from '@fluxer/errors/src/domains/channel/SearchIndexNotReadyError';
import {FeatureTemporarilyDisabledError} from '@fluxer/errors/src/domains/core/FeatureTemporarilyDisabledError';
import type {
	ThreadPostDataResponse,
	ThreadSearchQuery,
	ThreadSearchResponse,
} from '@fluxer/schema/src/domains/channel/ForumRequestSchemas';
import type {GuildMemberResponse} from '@fluxer/schema/src/domains/guild/GuildMemberSchemas';

const SEARCH_INDEX_RETRY_AFTER_SECONDS = 2;
const MAX_SEARCH_PRIVATE_THREAD_IDS = 1000;

export class ThreadForumService {
	/** 注入论坛帖子查询所需的业务依赖 */
	constructor(private readonly ctx: ThreadServiceContext) {}

	/** 按真实访问权限批量返回帖子的作者与首条消息。 */
	async postData(params: {
		viewer: ThreadViewer;
		userId: UserID;
		channelId: ChannelID;
		threadIds: Array<ChannelID>;
		requestCache: RequestCache;
	}): Promise<ThreadPostDataResponse> {
		const parentAuth = await this.authorizeParent(params.viewer, params.userId, params.channelId, true);
		const guildId = parentAuth.channel.guildId!;
		const {threads, channelData} = this.ctx.channelRepository;
		const requestedIds = [...new Set(params.threadIds)];
		const states = await filterThreadDiscoveryStates(
			this.ctx,
			parentAuth,
			params.userId,
			await threads.getStates(requestedIds),
		);
		const canReadMessageHistory = await parentAuth.hasPermission(Permissions.READ_MESSAGE_HISTORY);
		const threadIds = states.map((state) => state.threadId);
		const [channels, firstMessages] = await Promise.all([
			channelData.listChannels(threadIds),
			this.ctx.threadMessageResponses.getFirstMessages({
				userId: params.userId,
				guildId,
				canReadMessageHistory,
				messageHistoryCutoff: canReadMessageHistory ? null : (parentAuth.guild?.message_history_cutoff ?? null),
				threadIds,
			}),
		]);
		const ownerIds = [...new Set(channels.flatMap((channel) => (channel.ownerId ? [channel.ownerId] : [])))];
		const owners = new Map<string, GuildMemberResponse>(
			(
				await Promise.all(
					ownerIds.map(async (ownerId) => {
						const member = await this.ctx.guildRepository.getMember(guildId, createUserID(BigInt(ownerId)));
						if (!member) return [];
						return [
							[
								ownerId.toString(),
								await mapGuildMemberToResponse(member, this.ctx.userCacheService, params.requestCache),
							] as const,
						];
					}),
				)
			).flat(),
		);
		const ownerByThread = new Map(channels.map((channel) => [channel.id.toString(), channel.ownerId?.toString()]));
		return {
			threads: Object.fromEntries(
				threadIds.map((threadId) => {
					const key = threadId.toString();
					const ownerId = ownerByThread.get(key);
					return [
						key,
						{
							owner: ownerId ? (owners.get(ownerId) ?? null) : null,
							first_message: firstMessages.get(key) ?? null,
						},
					];
				}),
			),
		};
	}

	/** 在已有频道和私有线程权限范围内搜索帖子。 */
	async search(params: {
		viewer: ThreadViewer;
		userId: UserID;
		channelId: ChannelID;
		query: ThreadSearchQuery;
	}): Promise<ThreadSearchResponse> {
		const parentAuth = await this.authorizeParent(params.viewer, params.userId, params.channelId, false);
		const parent = parentAuth.channel;
		const guildId = parent.guildId!;
		if (!getThreadSearchService()) throw new FeatureTemporarilyDisabledError();
		const {threads} = this.ctx.channelRepository;
		const marker = await threads.getGuildMarker(guildId);
		if (!marker?.search_backfilled_at) {
			await enqueueThreadSearchBackfill(guildId.toString());
			throw new SearchIndexNotReadyError(SEARCH_INDEX_RETRY_AFTER_SECONDS);
		}
		const actor = await this.ctx.parentActor(parentAuth, params.userId);
		const moderator = isThreadModerator(withImplicitThreadBits(actor.permissions), actor);
		const {query} = params;
		const config = query.tag?.length ? await threads.getParentConfig(guildId, parent.id) : null;
		const tagSetting =
			query.tag_setting ??
			(config?.defaultTagSetting === ForumTagSettings.MATCH_ALL
				? ForumTagSettings.MATCH_ALL
				: ForumTagSettings.MATCH_SOME);
		const liveTagIds = new Set(config?.availableTags.map((tag) => tag.id.toString()));
		const requestedTags = query.tag?.map((id) => id.toString()) ?? [];
		const tagIds = requestedTags.filter((id) => liveTagIds.has(id));
		if (
			requestedTags.length > 0 &&
			(tagSetting === ForumTagSettings.MATCH_ALL ? tagIds.length < requestedTags.length : tagIds.length === 0)
		) {
			return {
				threads: [],
				members: [],
				has_more: false,
				total_results: 0,
				...(THREAD_ONLY_CHANNEL_TYPES.has(parent.type) ? {first_messages: []} : {}),
			};
		}
		const privateThreadIds =
			moderator || THREAD_ONLY_CHANNEL_TYPES.has(parent.type)
				? []
				: await threads.listJoinedPrivateThreadIds(params.userId, guildId, parent.id, MAX_SEARCH_PRIVATE_THREAD_IDS);
		const joinedPrivate = new Set(privateThreadIds.map((id) => id.toString()));
		const result = await searchThreadDocuments({
			name: query.name ?? '',
			filters: {
				guildId: guildId.toString(),
				parentId: parent.id.toString(),
				publicOnly: !moderator,
				privateThreadIds: [...joinedPrivate],
				archived: query.archived,
				tagIds,
				tagSetting,
				after: query.min_id !== undefined ? threadSearchCursor(query.min_id) : undefined,
				before: query.max_id !== undefined ? threadSearchCursor(query.max_id) : undefined,
				sortBy: query.sort_by,
				sortOrder: query.sort_order,
			},
			limit: query.limit,
			offset: query.offset,
		});
		if (!result) throw new FeatureTemporarilyDisabledError();
		const order = searchHitThreadIds(result);
		const states = await filterThreadDiscoveryStates(
			this.ctx,
			parentAuth,
			params.userId,
			await threads.getStates(order),
			actor,
		);
		const views = await loadThreadViews(this.ctx.channelRepository, states, [parent]);
		const viewById = new Map(views.map((view) => [view.state.threadId.toString(), view]));
		const ordered = order.flatMap((id) => {
			const view = viewById.get(id.toString());
			return view ? [view] : [];
		});
		const threadIds = ordered.map((view) => view.state.threadId);
		const members = (
			await Promise.all(threadIds.map((threadId) => threads.getMember(threadId, params.userId)))
		).flatMap((member) => (member ? [mapThreadMemberToResponse(member, {self: true})] : []));
		const response: ThreadSearchResponse = {
			threads: ordered.map((view) => mapThreadToResponse(view)),
			members,
			has_more: query.offset + result.hits.length < result.total,
			total_results: result.total,
		};
		if (THREAD_ONLY_CHANNEL_TYPES.has(parent.type)) {
			const canReadMessageHistory = await parentAuth.hasPermission(Permissions.READ_MESSAGE_HISTORY);
			const firstMessages = await this.ctx.threadMessageResponses.getFirstMessages({
				userId: params.userId,
				guildId,
				canReadMessageHistory,
				messageHistoryCutoff: canReadMessageHistory ? null : (parentAuth.guild?.message_history_cutoff ?? null),
				threadIds,
			});
			response.first_messages = threadIds.flatMap((threadId) => {
				const message = firstMessages.get(threadId.toString());
				return message ? [message] : [];
			});
		}
		return response;
	}

	private async authorizeParent(
		viewer: ThreadViewer,
		userId: UserID,
		channelId: ChannelID,
		threadOnly: boolean,
	): Promise<AuthenticatedChannel> {
		const auth = await this.ctx.channelAuth.getChannelAuthenticated({
			userId,
			channelId,
			viewer,
		});
		const allowed = threadOnly
			? THREAD_ONLY_CHANNEL_TYPES.has(auth.channel.type)
			: THREAD_PARENT_CHANNEL_TYPES.has(auth.channel.type);
		if (!auth.guild || !allowed) throw new InvalidChannelTypeError();
		assertThreadAllowed(canListArchivedThreads(await this.ctx.parentActor(auth, userId), {privateThreads: false}));
		return auth;
	}
}
