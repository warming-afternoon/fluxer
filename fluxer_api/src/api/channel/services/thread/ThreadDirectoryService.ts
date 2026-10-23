// SPDX-License-Identifier: AGPL-3.0-or-later

import {randomBytes} from 'node:crypto';
import {type ChannelID, createChannelID, type UserID} from '@app/api/BrandedTypes';
import {assertThreadAllowed} from '@app/api/channel/services/thread/ThreadDenials';
import {filterThreadDiscoveryStates} from '@app/api/channel/services/thread/ThreadDiscoveryAccess';
import {mapThreadMemberToResponse, mapThreadToResponse} from '@app/api/channel/services/thread/ThreadMappers';
import type {ThreadServiceContext} from '@app/api/channel/services/thread/ThreadServiceContext';
import {loadThreadViews} from '@app/api/channel/services/thread/ThreadViews';
import type {ThreadViewer} from '@app/api/experiment/ChannelThreadsGate';
import type {ThreadState} from '@app/api/models/ThreadState';
import {ForumTagSettings, THREAD_ONLY_CHANNEL_TYPES} from '@fluxer/constants/src/ThreadConstants';
import {canListArchivedThreads} from '@fluxer/constants/src/ThreadPermissionUtils';
import {ValidationErrorCodes} from '@fluxer/constants/src/ValidationErrorCodes';
import {InvalidChannelTypeError} from '@fluxer/errors/src/domains/channel/InvalidChannelTypeError';
import {InputValidationError} from '@fluxer/errors/src/domains/core/InputValidationError';
import type {
	ThreadDirectoryQuery,
	ThreadDirectoryResponse,
} from '@fluxer/schema/src/domains/channel/ForumRequestSchemas';

const DIRECTORY_BATCH_SIZE = 100;
const DIRECTORY_SCAN_LIMIT = 1000;
const CURSOR_TTL_SECONDS = 15 * 60;

interface DirectoryCursor {
	/** 请求用户、父频道、公会及筛选条件的规范化标识 */
	scope: string;

	/** 最后实际消费的原始帖子标识 */
	before: string;
}

export class ThreadDirectoryService {
	/** 注入按需目录查询所需的共享业务依赖 */
	constructor(private readonly ctx: ThreadServiceContext) {}

	/** 在固定扫描预算内按创建时间倒序返回当前用户可见的帖子 */
	async list(params: {
		viewer: ThreadViewer;
		userId: UserID;
		channelId: ChannelID;
		query: ThreadDirectoryQuery;
	}): Promise<ThreadDirectoryResponse> {
		// 每页重新鉴权，游标只保存位置，不保存权限结论
		const auth = await this.ctx.channelAuth.getChannelAuthenticated({
			viewer: params.viewer,
			userId: params.userId,
			channelId: params.channelId,
		});
		if (!auth.guild || !THREAD_ONLY_CHANNEL_TYPES.has(auth.channel.type)) throw new InvalidChannelTypeError();
		const actor = await this.ctx.parentActor(auth, params.userId);
		assertThreadAllowed(canListArchivedThreads(actor, {privateThreads: false}));
		const {query} = params;
		const repository = this.ctx.channelRepository;
		const config = await repository.threads.getParentConfig(auth.channel.guildId!, auth.channel.id);
		const tagSetting = query.tag_setting ?? config?.defaultTagSetting ?? ForumTagSettings.MATCH_SOME;
		const requestedTags = [...new Set(query.tag?.map(String) ?? [])].sort();
		const liveTags = new Set(config?.availableTags.map((tag) => tag.id.toString()));
		const tags = requestedTags.filter((tag) => liveTags.has(tag));
		const scope = JSON.stringify([
			params.userId.toString(),
			auth.channel.id.toString(),
			auth.channel.guildId!.toString(),
			query.archived,
			requestedTags,
			tagSetting,
		]);
		let before: ChannelID | undefined;
		if (query.cursor) {
			const cursor = await this.ctx.cacheService.get<DirectoryCursor>(`thread-directory:${query.cursor}`);
			if (!cursor || cursor.scope !== scope || !/^\d+$/.test(cursor.before)) {
				throw InputValidationError.fromCode('cursor', ValidationErrorCodes.INVALID_FORMAT);
			}
			before = createChannelID(BigInt(cursor.before));
		}
		const impossibleTags =
			requestedTags.length > 0 &&
			(tags.length === 0 || (tagSetting === ForumTagSettings.MATCH_ALL && tags.length !== requestedTags.length));
		const collected: Array<ThreadState> = [];
		let scanned = 0;
		let hasMore = false;
		while (!impossibleTags && scanned < DIRECTORY_SCAN_LIMIT && collected.length < query.limit) {
			const ids = await repository.threads.listDirectoryThreadIds(auth.channel.id, {
				before,
				limit: DIRECTORY_BATCH_SIZE,
			});
			if (ids.length === 0) {
				hasMore = false;
				break;
			}
			const states = await repository.threads.getStates(ids);
			const byId = new Map(states.map((state) => [state.threadId, state]));
			const visible = new Set(
				(await filterThreadDiscoveryStates(this.ctx, auth, params.userId, states, actor)).map(
					(state) => state.threadId,
				),
			);
			for (let index = 0; index < ids.length; index++) {
				// 游标只推进已消费项，批次中未消费的项留给下一页重读
				const id = ids[index]!;
				before = id;
				scanned++;
				const state = byId.get(id);
				if (
					state &&
					visible.has(id) &&
					state.archived === query.archived &&
					(tags.length === 0 ||
						(tagSetting === ForumTagSettings.MATCH_ALL
							? tags.every((tag) => state.appliedTags.some((id) => id.toString() === tag))
							: state.appliedTags.some((id) => tags.includes(id.toString()))))
				) {
					collected.push(state);
				}
				hasMore = index < ids.length - 1 || ids.length === DIRECTORY_BATCH_SIZE;
				if (collected.length >= query.limit || scanned >= DIRECTORY_SCAN_LIMIT) break;
			}
			if (ids.length < DIRECTORY_BATCH_SIZE) break;
		}
		let pinned: ThreadState | undefined;
		if (!query.cursor && !query.archived && !impossibleTags) {
			const pinId = await repository.threads.getForumPin(auth.channel.id);
			const pin = pinId ? await repository.threads.getState(pinId) : null;
			if (
				pin?.isPinned &&
				!pin.archived &&
				(tags.length === 0 ||
					(tagSetting === ForumTagSettings.MATCH_ALL
						? tags.every((tag) => pin.appliedTags.some((id) => id.toString() === tag))
						: pin.appliedTags.some((id) => tags.includes(id.toString())))) &&
				(await filterThreadDiscoveryStates(this.ctx, auth, params.userId, [pin], actor)).length > 0
			)
				pinned = pin;
		}
		const selected = new Map(collected.map((state) => [state.threadId, state]));
		if (pinned) selected.set(pinned.threadId, pinned);
		const views = await loadThreadViews(repository, [...selected.values()], [auth.channel]);
		const memberships = await Promise.all(
			views.map((view) => repository.threads.getMember(view.state.threadId, params.userId)),
		);
		const memberById = new Map(memberships.flatMap((member) => (member ? [[member.threadId, member] as const] : [])));
		const viewById = new Map(views.map((view) => [view.state.threadId, view]));
		const pinnedView = pinned ? viewById.get(pinned.threadId) : undefined;
		let nextCursor: string | null = null;
		if (hasMore && before !== undefined) {
			nextCursor = randomBytes(24).toString('base64url');
			await this.ctx.cacheService.set<DirectoryCursor>(
				`thread-directory:${nextCursor}`,
				{scope, before: before.toString()},
				CURSOR_TTL_SECONDS,
			);
		}
		return {
			threads: collected.flatMap((state) => {
				const view = viewById.get(state.threadId);
				return view ? [mapThreadToResponse(view, memberById.get(state.threadId))] : [];
			}),
			members: memberships.flatMap((member) => (member ? [mapThreadMemberToResponse(member, {self: true})] : [])),
			pinned_thread: pinnedView ? mapThreadToResponse(pinnedView, memberById.get(pinnedView.state.threadId)) : null,
			next_cursor: nextCursor,
			has_more: nextCursor !== null,
		};
	}
}
