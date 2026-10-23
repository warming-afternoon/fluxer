// SPDX-License-Identifier: AGPL-3.0-or-later

import {Endpoints} from '@app/features/app/constants/Endpoints';
import type {Channel, ChannelWire} from '@app/features/channel/models/Channel';
import Channels from '@app/features/channel/state/Channels';
import ForumReadState from '@app/features/forum/state/ForumReadState';
import {getDefaultLayout, getDefaultTagSetting} from '@app/features/forum/utils/ForumChannelUtils';
import Permission from '@app/features/permissions/state/Permission';
import {http} from '@app/features/platform/transport/RestTransport';
import {HttpError} from '@app/features/platform/types/EndpointError';
import {Logger} from '@app/features/platform/utils/AppLogger';
import ChannelThreads from '@app/features/threads/state/ChannelThreads';
import ThreadGuilds from '@app/features/threads/state/ThreadGuilds';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {Permissions} from '@fluxer/constants/src/ChannelConstants';
import {
	type ForumLayoutType,
	type ForumSortOrderType,
	ForumSortOrderTypes,
	type ForumTagSetting,
	POST_DATA_MAX_IDS,
	THREAD_SEARCH_MAX_LIMIT,
} from '@fluxer/constants/src/ThreadConstants';
import {ValidationErrorCodes} from '@fluxer/constants/src/ValidationErrorCodes';
import type {ThreadMemberResponse} from '@fluxer/schema/src/domains/channel/ThreadSchemas';
import type {Message as WireMessage} from '@fluxer/schema/src/domains/message/MessageResponseSchemas';
import {makeAutoObservable, observable, runInAction} from 'mobx';

const logger = new Logger('ForumPosts');

export const FORUM_SEARCH_DEBOUNCE_MS = 300;
export const POST_DATA_DEBOUNCE_MS = 50;
export const SEARCH_RETRY_MAX_ATTEMPTS = 6;
export const SEARCH_RETRY_MAX_DELAY_MS = 60_000;

export type ForumListKind = 'active' | 'archived' | 'search';

export interface ForumListState {
	/** 下一次目录扫描的游标，空结果页仍可能有下一页。 */
	readonly nextCursor?: string | null;

	/** 首屏额外返回的置顶帖子，不占分页数量。 */
	readonly pinnedId?: string | null;

	readonly ids: ReadonlyArray<string>;
	readonly hasMore: boolean;
	readonly loading: boolean;
	readonly loaded: boolean;
	readonly indexing: boolean;
	readonly failed: boolean;
}

interface ThreadSearchResponseBody {
	threads: Array<ChannelWire>;
	members: Array<ThreadMemberResponse>;
	has_more: boolean;
	total_results: number;
	first_messages?: Array<WireMessage>;
}

interface ThreadDirectoryResponseBody extends Omit<ThreadSearchResponseBody, 'total_results'> {
	/** 下一段扫描位置。 */
	next_cursor: string | null;

	/** 首屏可见的额外置顶帖子。 */
	pinned_thread: ChannelWire | null;
}

interface SearchNotReadyBody {
	code?: string;
	retry_after?: number;
}

interface DiscardedPost {
	/** 需要释放删除标记的所属目录。 */
	forumId: string | null;

	/** 失去访问发生时的单帖代次。 */
	revision: number;
}

interface PostDataResponseBody {
	threads?: Record<string, {first_message: WireMessage | null} | undefined>;
}

const EMPTY_LIST: ForumListState = Object.freeze({
	ids: [],
	hasMore: true,
	loading: false,
	loaded: false,
	indexing: false,
	failed: false,
});

const EMPTY_TAGS: ReadonlyArray<string> = Object.freeze([]);

interface ReactionEmojiKey {
	id?: string | null;
	name?: string | null;
}

type WireReaction = NonNullable<WireMessage['reactions']>[number];

function sameEmoji(a: ReactionEmojiKey, b: ReactionEmojiKey): boolean {
	return a.id != null ? a.id === b.id : b.id == null && a.name === b.name;
}

function applyReaction(
	reactions: ReadonlyArray<WireReaction>,
	emoji: ReactionEmojiKey,
	add: boolean,
	me: boolean,
): Array<WireReaction> | null {
	const existing = reactions.find((reaction) => sameEmoji(reaction.emoji, emoji));
	if (add) {
		if (!existing)
			return [
				...reactions,
				{emoji: {id: emoji.id ?? null, name: emoji.name ?? ''}, count: 1, me: me ? true : undefined},
			];
		if (me && existing.me) return null;
		return reactions.map((reaction) =>
			reaction === existing
				? {...reaction, count: reaction.count + 1, me: me || reaction.me ? true : undefined}
				: reaction,
		);
	}
	if (!existing || (me && !existing.me)) return null;
	if (existing.count <= 1) return reactions.filter((reaction) => reaction !== existing);
	return reactions.map((reaction) =>
		reaction === existing ? {...reaction, count: reaction.count - 1, me: me ? undefined : reaction.me} : reaction,
	);
}

function listKey(forumId: string, kind: ForumListKind): string {
	return `${forumId}:${kind}`;
}

export function canRequestForumPosts(forum: Channel): boolean {
	return (
		forum.isThreadOnly() &&
		ThreadGuilds.isActive(forum.guildId) &&
		Permission.can(Permissions.READ_MESSAGE_HISTORY, forum)
	);
}

export function searchRetryDelayMs(retryAfterSeconds: number | undefined, attempt: number): number {
	const base = Math.max(1, retryAfterSeconds ?? 1) * 1000;
	return Math.min(SEARCH_RETRY_MAX_DELAY_MS, base * 2 ** attempt);
}

function isSearchDisabledError(error: unknown): boolean {
	return (
		error instanceof HttpError &&
		error.status === 403 &&
		(error.body as {code?: string} | null)?.code === APIErrorCodes.FEATURE_TEMPORARILY_DISABLED
	);
}

function buildSearchPath(
	forumId: string,
	params: {
		name: string | null;
		tagIds: ReadonlyArray<string>;
		tagSetting: ForumTagSetting;
		archived: boolean | null;
		sortBy: 'last_message_time' | 'creation_time' | 'relevance';
		offset: number;
	},
): string {
	const search = new URLSearchParams();
	if (params.name) search.set('name', params.name);
	for (const tagId of params.tagIds) search.append('tag', tagId);
	if (params.tagIds.length > 1) search.set('tag_setting', params.tagSetting);
	if (params.archived != null) search.set('archived', String(params.archived));
	search.set('sort_by', params.sortBy);
	search.set('sort_order', 'desc');
	search.set('limit', String(THREAD_SEARCH_MAX_LIMIT));
	search.set('offset', String(params.offset));
	return `${Endpoints.CHANNEL_THREADS_SEARCH(forumId)}?${search.toString()}`;
}

class ForumPosts {
	private readonly lists = observable.map<string, ForumListState>();
	private readonly viewers = observable.map<string, number>();
	private readonly queries = observable.map<string, string>();
	private readonly tagFilters = observable.map<string, ReadonlyArray<string>>();
	private readonly sortOverrides = observable.map<string, ForumSortOrderType>();
	private readonly layoutOverrides = observable.map<string, ForumLayoutType>();
	private readonly firstMessages = observable.map<string, WireMessage | null>({}, {deep: false});
	private readonly generations = new Map<string, number>();
	private generationSerial = 0;
	previewVersion = 0;
	connectionVersion = 0;
	private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly retryAttempts = new Map<string, number>();
	private readonly searchTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly requestedPostData = new Set<string>();
	private readonly previewTokens = new Map<string, object>();
	private readonly discardedPosts = new Map<string, DiscardedPost>();
	private discardRevision = 0;
	private readonly pendingPostData = new Map<string, Set<string>>();
	private postDataTimer: ReturnType<typeof setTimeout> | null = null;
	searchUnavailable = false;

	constructor() {
		makeAutoObservable<
			this,
			| 'lists'
			| 'viewers'
			| 'queries'
			| 'tagFilters'
			| 'sortOverrides'
			| 'layoutOverrides'
			| 'firstMessages'
			| 'generations'
			| 'retryTimers'
			| 'retryAttempts'
			| 'searchTimers'
			| 'requestedPostData'
			| 'previewTokens'
			| 'discardedPosts'
			| 'pendingPostData'
			| 'postDataTimer'
		>(
			this,
			{
				lists: false,
				viewers: false,
				queries: false,
				tagFilters: false,
				sortOverrides: false,
				layoutOverrides: false,
				firstMessages: false,
				generations: false,
				retryTimers: false,
				retryAttempts: false,
				searchTimers: false,
				requestedPostData: false,
				previewTokens: false,
				discardedPosts: false,
				pendingPostData: false,
				postDataTimer: false,
			},
			{autoBind: true},
		);
	}

	/** 多个论坛视图共享目录，最后一个视图退出时释放请求和模型。 */
	beginViewing(forumId: string): () => void {
		this.viewers.set(forumId, (this.viewers.get(forumId) ?? 0) + 1);
		let released = false;
		return () =>
			runInAction(() => {
				if (released) return;
				released = true;
				const count = this.viewers.get(forumId) ?? 0;
				if (count > 1) {
					this.viewers.set(forumId, count - 1);
					return;
				}
				this.viewers.delete(forumId);
				const ids = new Set<string>();
				for (const kind of ['active', 'archived', 'search'] as const) {
					const list = this.getList(forumId, kind);
					for (const id of list.ids) ids.add(id);
					if (list.pinnedId) ids.add(list.pinnedId);
					this.resetList(forumId, kind);
				}
				this.cancelSearchTimer(forumId);
				this.pendingPostData.delete(forumId);
				this.previewVersion += 1;
				this.previewTokens.delete(forumId);
				for (const [id, discarded] of this.discardedPosts)
					if (discarded.forumId === forumId) this.discardedPosts.delete(id);
				for (const id of ids) {
					this.requestedPostData.delete(id);
					this.firstMessages.delete(id);
				}
				ForumReadState.refreshPosts([...ids]);
			});
	}

	/** 只允许实际打开的论坛继续发起分页或预览请求。 */
	isViewing(forumId: string): boolean {
		return (this.viewers.get(forumId) ?? 0) > 0;
	}

	getList(forumId: string, kind: ForumListKind): ForumListState {
		return this.lists.get(listKey(forumId, kind)) ?? EMPTY_LIST;
	}

	getQuery(forumId: string): string {
		return this.queries.get(forumId) ?? '';
	}

	isSearching(forumId: string): boolean {
		return this.getQuery(forumId).trim().length > 0;
	}

	getTagFilter(forumId: string): ReadonlyArray<string> {
		return this.tagFilters.get(forumId) ?? EMPTY_TAGS;
	}

	/** 目录固定按创建时间排序，忽略历史配置。 */
	getSortOrder(_forum: Channel): ForumSortOrderType {
		return ForumSortOrderTypes.CREATION_TIME;
	}

	getLayout(forum: Channel): ForumLayoutType {
		return this.layoutOverrides.get(forum.id) ?? getDefaultLayout(forum);
	}

	getFirstMessage(threadId: string): WireMessage | null | undefined {
		return this.firstMessages.get(threadId);
	}

	setLayout(forum: Channel, layout: ForumLayoutType): void {
		this.layoutOverrides.set(forum.id, layout);
	}

	setSortOrder(forum: Channel, sortOrder: ForumSortOrderType): void {
		if (this.getSortOrder(forum) === sortOrder) return;
		this.sortOverrides.set(forum.id, sortOrder);
		this.resetList(forum.id, 'archived');
	}

	setTagFilter(forum: Channel, tagIds: ReadonlyArray<string>): void {
		this.tagFilters.set(forum.id, [...tagIds]);
		this.resetList(forum.id, 'active');
		this.resetList(forum.id, 'archived');
		if (this.isSearching(forum.id)) {
			this.cancelSearchTimer(forum.id);
			void this.fetchList(forum, 'search', false);
		}
	}

	toggleTag(forum: Channel, tagId: string): void {
		const current = this.getTagFilter(forum.id);
		this.setTagFilter(forum, current.includes(tagId) ? current.filter((id) => id !== tagId) : [...current, tagId]);
	}

	setQuery(forum: Channel, query: string): void {
		this.queries.set(forum.id, query);
		this.cancelSearchTimer(forum.id);
		this.resetList(forum.id, 'search');
		if (!query.trim()) {
			this.resetList(forum.id, 'search');
			return;
		}
		const forumId = forum.id;
		this.searchTimers.set(
			forumId,
			setTimeout(() => {
				this.searchTimers.delete(forumId);
				const current = Channels.getChannel(forumId);
				if (current) void this.fetchList(current, 'search', false);
			}, FORUM_SEARCH_DEBOUNCE_MS),
		);
	}

	loadMore(forum: Channel, kind: ForumListKind): void {
		const list = this.getList(forum.id, kind);
		if (list.loading) return;
		void this.fetchList(forum, kind, list.loaded);
	}

	/** 手动刷新当前目录，保留搜索、标签和布局偏好。 */
	refresh(forum: Channel): void {
		if (!this.isViewing(forum.id)) return;
		this.cancelSearchTimer(forum.id);
		this.previewVersion += 1;
		this.previewTokens.delete(forum.id);
		this.pendingPostData.delete(forum.id);
		for (const kind of ['active', 'archived', 'search'] as const) {
			const list = this.getList(forum.id, kind);
			for (const id of [...list.ids, ...(list.pinnedId ? [list.pinnedId] : [])]) {
				this.requestedPostData.delete(id);
				this.firstMessages.delete(id);
			}
			ForumReadState.refreshPosts([...list.ids, ...(list.pinnedId ? [list.pinnedId] : [])]);
			this.resetList(forum.id, kind);
		}
		const kind = this.isSearching(forum.id) ? 'search' : 'active';
		void this.fetchList(forum, kind, false);
	}

	/** 删除或失去访问时使该帖子的旧响应失效，保留其他合法分页结果。 */
	discardPost(threadId: string, forumId: string | null): void {
		if (forumId ? this.isViewing(forumId) : this.viewers.size > 0) {
			this.discardedPosts.set(threadId, {forumId, revision: ++this.discardRevision});
		}
		this.requestedPostData.delete(threadId);
		this.firstMessages.delete(threadId);
		ForumReadState.refreshPosts([threadId]);
		if (!forumId) return;
		this.pendingPostData.get(forumId)?.delete(threadId);
		for (const kind of ['active', 'archived', 'search'] as const) {
			const key = listKey(forumId, kind);
			const list = this.lists.get(key);
			if (!list) continue;
			this.lists.set(key, {
				...list,
				ids: list.ids.filter((id) => id !== threadId),
				pinnedId: list.pinnedId === threadId ? null : list.pinnedId,
			});
		}
		this.syncReferences(forumId);
	}

	retry(forum: Channel, kind: ForumListKind): void {
		this.retryAttempts.delete(listKey(forum.id, kind));
		const list = this.getList(forum.id, kind);
		void this.fetchList(forum, kind, list.loaded);
	}

	requestPostData(forum: Channel, threadIds: ReadonlyArray<string>): void {
		if (!canRequestForumPosts(forum) || !this.isViewing(forum.id)) return;
		let pending = this.pendingPostData.get(forum.id);
		for (const threadId of threadIds) {
			if (this.requestedPostData.has(threadId) || this.firstMessages.has(threadId)) continue;
			this.requestedPostData.add(threadId);
			pending ??= new Set();
			pending.add(threadId);
		}
		if (pending == null || pending.size === 0) return;
		this.pendingPostData.set(forum.id, pending);
		if (this.postDataTimer == null) {
			this.postDataTimer = setTimeout(this.flushPostData, POST_DATA_DEBOUNCE_MS);
		}
	}

	setFirstMessage(message: WireMessage): void {
		this.firstMessages.set(message.channel_id, message);
	}

	handleMessageUpdate(message: Partial<WireMessage> & {id: string}): void {
		if (message.id !== message.channel_id) return;
		const existing = this.firstMessages.get(message.id);
		if (existing) this.firstMessages.set(message.id, {...existing, ...message});
	}

	handleMessageDelete(channelId: string, messageId: string): void {
		if (messageId !== channelId || !this.firstMessages.has(messageId)) return;
		this.firstMessages.set(messageId, null);
	}

	handleReaction(channelId: string, messageId: string, emoji: ReactionEmojiKey, add: boolean, me: boolean): void {
		if (messageId !== channelId) return;
		const existing = this.firstMessages.get(messageId);
		if (!existing) return;
		const reactions = applyReaction(existing.reactions ?? [], emoji, add, me);
		if (reactions) this.firstMessages.set(messageId, {...existing, reactions});
	}

	handleReactionClear(channelId: string, messageId: string, emoji?: ReactionEmojiKey): void {
		if (messageId !== channelId) return;
		const existing = this.firstMessages.get(messageId);
		if (!existing?.reactions?.length) return;
		const reactions = emoji ? existing.reactions.filter((reaction) => !sameEmoji(reaction.emoji, emoji)) : [];
		this.firstMessages.set(messageId, {...existing, reactions});
	}

	handleGatewayReady(): void {
		this.previewTokens.clear();
		this.discardedPosts.clear();
		this.connectionVersion += 1;
		for (const forumId of [...this.searchTimers.keys()]) this.cancelSearchTimer(forumId);
		this.previewVersion += 1;
		// 只使已浏览的列表失效，页面挂载后自行请求，不遍历社区回源。
		for (const key of [...this.lists.keys()]) {
			const separator = key.lastIndexOf(':');
			this.resetList(key.slice(0, separator), key.slice(separator + 1) as ForumListKind);
		}
		this.firstMessages.clear();
		this.requestedPostData.clear();
	}

	purgeForum(forumId: string, threadIds: ReadonlyArray<string>): void {
		this.previewTokens.delete(forumId);
		for (const [id, discarded] of this.discardedPosts)
			if (discarded.forumId === forumId) this.discardedPosts.delete(id);
		this.previewVersion += 1;
		const postIds = new Set([...threadIds, ...(this.pendingPostData.get(forumId) ?? [])]);
		for (const kind of ['active', 'archived', 'search'] as const) {
			for (const id of this.getList(forumId, kind).ids) postIds.add(id);
			this.resetList(forumId, kind);
		}
		this.cancelSearchTimer(forumId);
		this.queries.delete(forumId);
		this.tagFilters.delete(forumId);
		this.pendingPostData.delete(forumId);
		for (const id of postIds) {
			this.requestedPostData.delete(id);
			this.firstMessages.delete(id);
		}
	}

	reset(): void {
		this.previewTokens.clear();
		this.discardedPosts.clear();
		this.previewVersion += 1;
		for (const timer of this.retryTimers.values()) clearTimeout(timer);
		for (const timer of this.searchTimers.values()) clearTimeout(timer);
		if (this.postDataTimer != null) clearTimeout(this.postDataTimer);
		this.postDataTimer = null;
		this.retryTimers.clear();
		this.searchTimers.clear();
		this.retryAttempts.clear();
		this.generations.clear();
		this.viewers.clear();
		this.requestedPostData.clear();
		this.pendingPostData.clear();
		for (const key of this.lists.keys()) ChannelThreads.setDirectoryReferences(key.split(':')[0], new Set());
		this.lists.clear();
		this.queries.clear();
		this.tagFilters.clear();
		this.sortOverrides.clear();
		this.layoutOverrides.clear();
		this.firstMessages.clear();
		this.searchUnavailable = false;
	}

	private cancelSearchTimer(forumId: string): void {
		const timer = this.searchTimers.get(forumId);
		if (timer != null) clearTimeout(timer);
		this.searchTimers.delete(forumId);
	}

	private cancelRetry(key: string): void {
		const timer = this.retryTimers.get(key);
		if (timer != null) clearTimeout(timer);
		this.retryTimers.delete(key);
	}

	private resetList(forumId: string, kind: ForumListKind): void {
		const key = listKey(forumId, kind);
		this.generations.set(key, ++this.generationSerial);
		this.cancelRetry(key);
		this.retryAttempts.delete(key);
		this.lists.delete(key);
		this.syncReferences(forumId);
	}

	private async fetchList(forum: Channel, kind: ForumListKind, append: boolean): Promise<void> {
		if (!canRequestForumPosts(forum) || !this.isViewing(forum.id)) return;
		const key = listKey(forum.id, kind);
		const current = this.getList(forum.id, kind);
		if (append && (current.loading || !current.hasMore)) return;
		const query = this.getQuery(forum.id).trim();
		if (kind === 'search' && !query) return;
		const generation = ++this.generationSerial;
		const requestRevision = this.discardRevision;
		this.generations.set(key, generation);
		this.cancelRetry(key);
		const base = append ? current : EMPTY_LIST;
		this.lists.set(key, {...base, loading: true, failed: false});
		if (kind !== 'search') {
			await this.fetchDirectory(forum, kind, append, base, generation, requestRevision);
			return;
		}
		const path = buildSearchPath(forum.id, {
			name: query,
			tagIds: this.getTagFilter(forum.id),
			tagSetting: getDefaultTagSetting(forum),
			archived: null,
			sortBy: 'relevance',
			offset: append ? current.ids.length : 0,
		});
		try {
			const response = await http.get<ThreadSearchResponseBody | SearchNotReadyBody>(path);
			if (this.generations.get(key) !== generation || !canRequestForumPosts(forum) || !this.isViewing(forum.id)) return;
			if (response.status === 202) {
				this.scheduleRetry(forum.id, kind, append, base, (response.body as SearchNotReadyBody | null)?.retry_after);
				return;
			}
			const body = response.body as ThreadSearchResponseBody;
			runInAction(() => {
				this.retryAttempts.delete(key);
				const ids = this.ingestSearch(forum, body, requestRevision);
				const merged = (append ? [...current.ids, ...ids.filter((id) => !current.ids.includes(id))] : ids).filter(
					(id) => (this.discardedPosts.get(id)?.revision ?? 0) <= requestRevision,
				);
				this.lists.set(key, {
					ids: merged,
					hasMore: body.has_more,
					loading: false,
					loaded: true,
					indexing: false,
					failed: false,
				});
				this.syncReferences(forum.id);
			});
		} catch (error) {
			if (this.generations.get(key) !== generation) return;
			if (isSearchDisabledError(error)) {
				this.disableSearch();
				return;
			}
			logger.warn(`Failed to load ${kind} posts for forum ${forum.id}`, error);
			runInAction(() => {
				this.lists.set(key, {...base, loading: false, indexing: false, failed: true});
			});
		}
	}

	private disableSearch(): void {
		this.searchUnavailable = true;
		for (const timer of this.searchTimers.values()) clearTimeout(timer);
		this.searchTimers.clear();
		for (const id of Array.from(this.queries.keys())) this.resetList(id, 'search');
		this.queries.clear();
	}

	/** 目录使用独立游标，空扫描页也保留下一段位置。 */
	private async fetchDirectory(
		forum: Channel,
		kind: 'active' | 'archived',
		append: boolean,
		base: ForumListState,
		generation: number,
		requestRevision: number,
	): Promise<void> {
		const key = listKey(forum.id, kind);
		const query = new URLSearchParams({archived: String(kind === 'archived'), limit: '50'});
		for (const tag of this.getTagFilter(forum.id)) query.append('tag', tag);
		query.set('tag_setting', getDefaultTagSetting(forum));
		if (append && base.nextCursor) query.set('cursor', base.nextCursor);
		try {
			const response = await http.get<ThreadDirectoryResponseBody>(
				`${Endpoints.CHANNEL_THREADS(forum.id)}/directory?${query}`,
			);
			if (this.generations.get(key) !== generation || !canRequestForumPosts(forum) || !this.isViewing(forum.id)) return;
			const body = response.body;
			runInAction(() => {
				const ids = this.ingestSearch(forum, body, requestRevision);
				const pin =
					!append &&
					body.pinned_thread &&
					(this.discardedPosts.get(body.pinned_thread.id)?.revision ?? 0) <= requestRevision
						? ChannelThreads.upsert(body.pinned_thread, forum.guildId)
						: undefined;
				this.lists.set(key, {
					ids: (append ? [...base.ids, ...ids.filter((id) => !base.ids.includes(id))] : ids).filter(
						(id) => (this.discardedPosts.get(id)?.revision ?? 0) <= requestRevision,
					),
					pinnedId: append
						? base.pinnedId && (this.discardedPosts.get(base.pinnedId)?.revision ?? 0) <= requestRevision
							? base.pinnedId
							: null
						: (pin?.id ?? null),
					nextCursor: body.next_cursor,
					hasMore: body.has_more,
					loading: false,
					loaded: true,
					indexing: false,
					failed: false,
				});
				this.syncReferences(forum.id);
			});
		} catch (error) {
			if (this.generations.get(key) !== generation) return;
			// 只有携带旧游标的请求恢复一次，首屏失败直接呈现重试。
			const cursorInvalid =
				error instanceof HttpError &&
				error.status === 400 &&
				(error.body as {errors?: Array<{path?: string; code?: string}>} | null)?.errors?.some(
					(validation) => validation.path === 'cursor' && validation.code === ValidationErrorCodes.INVALID_FORMAT,
				);
			if (append && base.nextCursor && cursorInvalid) {
				this.resetList(forum.id, kind);
				await this.fetchList(forum, kind, false);
				return;
			}
			logger.warn(`Failed to load ${kind} directory for forum ${forum.id}`, error);
			runInAction(() => this.lists.set(key, {...base, loading: false, failed: true}));
		}
	}

	/** 只保留目录和搜索结果引用，不为卡片建立实时浏览关系。 */
	private syncReferences(forumId: string): void {
		const ids = new Set<string>();
		for (const kind of ['active', 'archived', 'search'] as const) {
			const list = this.getList(forumId, kind);
			for (const id of list.ids) ids.add(id);
			if (list.pinnedId) ids.add(list.pinnedId);
		}
		ChannelThreads.setDirectoryReferences(forumId, ids);
	}

	private scheduleRetry(
		forumId: string,
		kind: ForumListKind,
		append: boolean,
		base: ForumListState,
		retryAfterSeconds: number | undefined,
	): void {
		const key = listKey(forumId, kind);
		const attempt = this.retryAttempts.get(key) ?? 0;
		runInAction(() => {
			if (attempt >= SEARCH_RETRY_MAX_ATTEMPTS) {
				this.retryAttempts.delete(key);
				this.lists.set(key, {...base, loading: false, indexing: false, failed: true});
				return;
			}
			this.retryAttempts.set(key, attempt + 1);
			this.lists.set(key, {...base, loading: false, indexing: true, failed: false});
		});
		if (attempt >= SEARCH_RETRY_MAX_ATTEMPTS) return;
		const generation = this.generations.get(key);
		this.retryTimers.set(
			key,
			setTimeout(
				() => {
					this.retryTimers.delete(key);
					if (this.generations.get(key) !== generation) return;
					const forum = Channels.getChannel(forumId);
					if (forum) void this.fetchList(forum, kind, append);
				},
				searchRetryDelayMs(retryAfterSeconds, attempt),
			),
		);
	}

	private ingestSearch(
		forum: Channel,
		body: Pick<ThreadSearchResponseBody, 'threads' | 'members' | 'first_messages'>,
		requestRevision: number,
	): Array<string> {
		const members = new Map<string, ThreadMemberResponse>();
		for (const member of body.members ?? []) {
			if (member.id) members.set(member.id, member);
		}
		const ids: Array<string> = [];
		for (const thread of body.threads ?? []) {
			if ((this.discardedPosts.get(thread.id)?.revision ?? 0) > requestRevision) continue;
			const member = members.get(thread.id);
			const post = ChannelThreads.upsert(member ? {...thread, member} : thread, forum.guildId);
			if (post?.parentId === forum.id) ids.push(post.id);
		}
		for (const message of body.first_messages ?? []) {
			if ((this.discardedPosts.get(message.channel_id)?.revision ?? 0) > requestRevision) continue;
			this.firstMessages.set(message.channel_id, message);
		}
		return ids;
	}

	private flushPostData(): void {
		this.postDataTimer = null;
		const batches = Array.from(this.pendingPostData);
		this.pendingPostData.clear();
		for (const [forumId, pending] of batches) {
			const forum = Channels.getChannel(forumId);
			const ids = Array.from(pending);
			if (!forum || !canRequestForumPosts(forum) || !this.isViewing(forum.id)) {
				for (const id of ids) this.requestedPostData.delete(id);
				continue;
			}
			for (let index = 0; index < ids.length; index += POST_DATA_MAX_IDS) {
				void this.fetchPostData(forum, ids.slice(index, index + POST_DATA_MAX_IDS));
			}
		}
	}

	private async fetchPostData(forum: Channel, threadIds: Array<string>): Promise<void> {
		const requestRevision = this.discardRevision;
		const token = this.previewTokens.get(forum.id) ?? {};
		this.previewTokens.set(forum.id, token);
		try {
			const response = await http.post<PostDataResponseBody>(Endpoints.CHANNEL_POST_DATA(forum.id), {
				body: {thread_ids: threadIds},
			});
			if (this.previewTokens.get(forum.id) !== token || !canRequestForumPosts(forum)) return;
			runInAction(() => {
				for (const threadId of threadIds) {
					if (
						!this.requestedPostData.has(threadId) ||
						(this.discardedPosts.get(threadId)?.revision ?? 0) > requestRevision
					)
						continue;
					this.firstMessages.set(threadId, response.body?.threads?.[threadId]?.first_message ?? null);
				}
			});
		} catch (error) {
			if (this.previewTokens.get(forum.id) !== token) return;
			for (const threadId of threadIds) this.requestedPostData.delete(threadId);
			logger.warn(`Failed to load post data for forum ${forum.id}`, error);
		}
	}
}

export default new ForumPosts();
