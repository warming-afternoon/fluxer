// SPDX-License-Identifier: AGPL-3.0-or-later

import Channels from '@app/features/channel/state/Channels';
import GatewaySessions from '@app/features/gateway/transport/GatewaySessionPool';
import Guilds from '@app/features/guild/state/Guilds';
import * as MessageCommands from '@app/features/messaging/commands/MessageCommands';
import type {Message} from '@app/features/messaging/models/MessagingMessage';
import type {JumpOptions} from '@app/features/messaging/state/ChannelMessages';
import {ChannelMessages} from '@app/features/messaging/state/ChannelMessages';
import type {ReactionEmoji} from '@app/features/messaging/utils/ReactionUtils';
import SelectedChannel from '@app/features/navigation/state/SelectedChannel';
import SelectedGuild from '@app/features/navigation/state/SelectedGuild';
import {AccountScopedWork} from '@app/features/platform/state/AccountScopedWork';
import Relationships from '@app/features/relationship/state/Relationships';
import Dimension from '@app/features/ui/state/Dimension';
import Users from '@app/features/user/state/Users';
import {FAVORITES_GUILD_ID, ME} from '@fluxer/constants/src/AppConstants';
import {MessageStates} from '@fluxer/constants/src/ChannelConstants';
import {type JumpType, JumpTypes} from '@fluxer/constants/src/JumpConstants';
import {MAX_MESSAGES_PER_CHANNEL} from '@fluxer/constants/src/LimitConstants';
import type {ChannelId} from '@fluxer/schema/src/branded/WireIds';
import type {GuildMemberData} from '@fluxer/schema/src/domains/guild/GuildMemberSchemas';
import type {Message as WireMessage} from '@fluxer/schema/src/domains/message/MessageResponseSchemas';
import {makeAutoObservable, reaction} from 'mobx';

const STALE_WINDOW_REFETCH_INTERVAL_MS = 10_000;
const staleWindowRefetchedAt = new Map<string, number>();

interface GuildMemberUpdateAction {
	type: 'GUILD_MEMBER_UPDATE';
	guildId: string;
	member: GuildMemberData;
}

export interface PendingJumpDispatch {
	messageId: string;
	flash?: boolean;
	offset?: number;
	returnToMessageId?: string;
	returnChannelId?: string | null;
	returnGuildId?: string | null;
	jumpType?: JumpType;
}

export interface WatchWindowRefresh {
	// 请求开始时的窗口，用于识别实时变化
	baseline: ChannelMessages | undefined;

	// 请求期间收到的新增和编辑内容
	updates: Map<string, Partial<WireMessage>>;

	// 请求期间收到的删除，包含当时尚未加载的消息
	deleted: Set<string>;

	// 请求期间真正新增的消息标识
	created: Set<string>;

	// 请求期间已加载消息的反应快照
	reactions: Map<string, WireMessage['reactions']>;

	// 事件过多时放弃本次快照，避免恢复缓冲无限增长
	overflowed: boolean;
}

class Messages {
	private watchRefreshes = new Map<string, WatchWindowRefresh>();
	private pendingJumpDispatches = new Map<string, PendingJumpDispatch>();
	private messageRefsByAuthor = new Map<string, Map<string, Set<string>>>();
	private indexedAuthorsByChannel = new Map<string, Map<string, string>>();
	updateCounter = 0;
	cacheGeneration = 0;
	private pendingFullHydration = false;

	constructor() {
		makeAutoObservable<this, 'messageRefsByAuthor' | 'indexedAuthorsByChannel' | 'watchRefreshes'>(
			this,
			{
				messageRefsByAuthor: false,
				indexedAuthorsByChannel: false,
				watchRefreshes: false,
			},
			{autoBind: true},
		);
	}

	get version(): number {
		return this.updateCounter;
	}

	private notifyChange(): void {
		this.updateCounter += 1;
	}

	private commitMessages(messages: ChannelMessages): ChannelMessages {
		const committed = ChannelMessages.commit(messages) ?? messages;
		this.pruneStaleIndexedChannels();
		this.indexChannelMessages(committed);
		return committed;
	}

	private clearMessages(channelId: string): void {
		ChannelMessages.clear(channelId);
		this.unindexChannelMessages(channelId);
	}

	private indexChannelMessages(messages: ChannelMessages): void {
		this.unindexChannelMessages(messages.channelId);
		if (messages.length === 0) {
			return;
		}
		const channelIndex = new Map<string, string>();
		messages.forEach((message) => {
			const authorId = message.author.id;
			channelIndex.set(message.id, authorId);
			let refsByChannel = this.messageRefsByAuthor.get(authorId);
			if (!refsByChannel) {
				refsByChannel = new Map();
				this.messageRefsByAuthor.set(authorId, refsByChannel);
			}
			let messageIds = refsByChannel.get(messages.channelId);
			if (!messageIds) {
				messageIds = new Set();
				refsByChannel.set(messages.channelId, messageIds);
			}
			messageIds.add(message.id);
		});
		this.indexedAuthorsByChannel.set(messages.channelId, channelIndex);
	}

	private unindexChannelMessages(channelId: string): void {
		const channelIndex = this.indexedAuthorsByChannel.get(channelId);
		if (!channelIndex) {
			return;
		}
		for (const [messageId, authorId] of channelIndex) {
			this.unindexMessageRef(authorId, channelId, messageId);
		}
		this.indexedAuthorsByChannel.delete(channelId);
	}

	private unindexMessageRef(authorId: string, channelId: string, messageId: string): void {
		const refsByChannel = this.messageRefsByAuthor.get(authorId);
		if (!refsByChannel) {
			return;
		}
		const messageIds = refsByChannel.get(channelId);
		if (!messageIds) {
			return;
		}
		messageIds.delete(messageId);
		if (messageIds.size === 0) {
			refsByChannel.delete(channelId);
		}
		if (refsByChannel.size === 0) {
			this.messageRefsByAuthor.delete(authorId);
		}
	}

	private pruneStaleIndexedChannels(): void {
		for (const channelId of Array.from(this.indexedAuthorsByChannel.keys())) {
			if (!ChannelMessages.get(channelId)) {
				this.unindexChannelMessages(channelId);
			}
		}
	}

	private patchAuthorMessages(
		userId: string,
		updater: (message: Message) => Message,
		options: {guildId?: string | null; patchMissingChannels?: boolean} = {},
	): boolean {
		const refsByChannel = this.messageRefsByAuthor.get(userId);
		if (!refsByChannel) {
			return false;
		}
		let hasChanges = false;
		const channelRefs = Array.from(refsByChannel, ([channelId, messageIds]) => ({
			channelId,
			messageIds: Array.from(messageIds),
		}));
		for (const {channelId, messageIds} of channelRefs) {
			let messages = ChannelMessages.get(channelId);
			if (!messages) {
				this.unindexChannelMessages(channelId);
				continue;
			}
			if (options.guildId != null) {
				const channel = Channels.getChannel(channelId);
				if (channel == null) {
					if (!options.patchMissingChannels) {
						continue;
					}
				} else if (channel.guildId !== options.guildId) {
					continue;
				}
			}
			const previous = messages;
			for (const messageId of messageIds) {
				if (!messages.has(messageId, false)) {
					this.unindexMessageRef(userId, channelId, messageId);
					continue;
				}
				messages = messages.update(messageId, updater);
			}
			if (messages !== previous) {
				this.commitMessages(messages);
				hasChanges = true;
			}
		}
		return hasChanges;
	}

	getMessages(channelId: string): ChannelMessages {
		const messages = ChannelMessages.getOrCreate(channelId);
		this.pruneStaleIndexedChannels();
		return messages;
	}

	getCachedMessages(channelId: string): ChannelMessages | undefined {
		return ChannelMessages.get(channelId);
	}

	private hasLoadedPage(messages: ChannelMessages): boolean {
		return messages.ready && messages.length > 0 && !messages.cached;
	}

	shouldPreloadLatestPage(channelId: string): boolean {
		if (!GatewaySessions.foregroundConnection.isConnected || !Channels.getChannel(channelId)) {
			return false;
		}
		const messages = ChannelMessages.get(channelId);
		if (!messages) return true;
		if (messages.loadingMore || ChannelMessages.isRetained(channelId)) return false;
		return messages.length === 0 ? !messages.ready : messages.cached;
	}

	preloadLatestPage(channelId: string, guildId?: string | null): boolean {
		if (!this.shouldPreloadLatestPage(channelId)) {
			return false;
		}
		const channel = Channels.getChannel(channelId);
		const resolvedGuildId = guildId ?? channel?.guildId ?? (channel?.isPrivate() ? ME : undefined);
		this.handleChannelSelect({guildId: resolvedGuildId ?? undefined, channelId});
		return true;
	}

	getMessage(channelId: string, messageId: string): Message | undefined {
		return ChannelMessages.getOrCreate(channelId).get(messageId);
	}

	getLastEditableMessage(channelId: string): Message | undefined {
		return this.getMessages(channelId).searchFromNewest((message) => {
			return (
				message.isCurrentUserAuthor() &&
				message.state === MessageStates.SENT &&
				message.isUserMessage() &&
				!message.messageSnapshots
			);
		});
	}

	hasNewestMessages(channelId: string): boolean {
		const channel = ChannelMessages.get(channelId);
		return channel?.hasNewestMessages() ?? false;
	}

	setPendingJumpDispatch(channelId: string, dispatch: PendingJumpDispatch): void {
		this.pendingJumpDispatches.set(channelId, dispatch);
	}

	private takePendingJumpDispatch(channelId: string, messageId: string): PendingJumpDispatch | null {
		const dispatch = this.pendingJumpDispatches.get(channelId);
		if (!dispatch) return null;
		this.pendingJumpDispatches.delete(channelId);
		return dispatch.messageId === messageId ? dispatch : null;
	}

	/** 会话失效时丢弃消息缓存和正在恢复的窗口记录 */
	handleSessionInvalidated(): boolean {
		this.watchRefreshes.clear();
		const channelIds: Array<string> = [];
		let discardedLoadedMessages = false;
		ChannelMessages.forEach((messages) => {
			channelIds.push(messages.channelId);
			discardedLoadedMessages ||= messages.length > 0;
		});
		for (const channelId of channelIds) {
			this.clearMessages(channelId);
			Dimension.forgetChannelDimensions(channelId);
		}
		this.messageRefsByAuthor.clear();
		this.indexedAuthorsByChannel.clear();
		this.pendingJumpDispatches.clear();
		this.pendingFullHydration = true;
		if (discardedLoadedMessages) {
			this.cacheGeneration += 1;
		}
		this.notifyChange();
		return true;
	}

	handleGatewayReady(): boolean {
		if (AccountScopedWork.isSuspended) {
			return false;
		}
		const selectedChannelId = SelectedChannel.currentChannelId;
		let didHydrateSelectedChannel = false;
		if (selectedChannelId) {
			const pending = this.pendingJumpDispatches.get(selectedChannelId);
			if (pending) {
				this.pendingJumpDispatches.delete(selectedChannelId);
				MessageCommands.jumpToMessage({channelId: selectedChannelId, ...pending});
				this.pendingFullHydration = false;
				return true;
			}
		}
		ChannelMessages.forEach((messages) => {
			if (messages.channelId === selectedChannelId && Channels.getChannel(messages.channelId) != null) {
				this.startChannelHydration(messages.channelId, {forceScrollToBottom: this.pendingFullHydration});
				didHydrateSelectedChannel = true;
			} else {
				this.commitMessages(messages.withPatch({ready: false, loadingMore: false}));
			}
		});
		if (this.pendingFullHydration && !didHydrateSelectedChannel && selectedChannelId) {
			this.startChannelHydration(selectedChannelId, {forceScrollToBottom: true});
			didHydrateSelectedChannel = true;
		}
		this.pendingFullHydration = false;
		if (!didHydrateSelectedChannel && selectedChannelId && Channels.getChannel(selectedChannelId)) {
			const messages = ChannelMessages.getOrCreate(selectedChannelId);
			if (!messages.ready && !messages.loadingMore && messages.length === 0) {
				this.commitMessages(messages.withPatch({loadingMore: true}));
				MessageCommands.fetchMessages(selectedChannelId, null, null, MAX_MESSAGES_PER_CHANNEL);
				didHydrateSelectedChannel = true;
			}
		}
		this.notifyChange();
		return didHydrateSelectedChannel;
	}

	private startChannelHydration(channelId: string, options: {forceScrollToBottom?: boolean} = {}): void {
		if (!Channels.getChannel(channelId)) return;
		const {forceScrollToBottom = false} = options;
		const messages = ChannelMessages.getOrCreate(channelId);
		this.commitMessages(messages.withPatch({loadingMore: true, ready: false, error: false}));
		if (forceScrollToBottom) {
			Dimension.recordChannelDimensions(channelId, 1, 1, 0);
		}
		MessageCommands.fetchMessages(channelId, null, null, MAX_MESSAGES_PER_CHANNEL);
	}

	handleChannelSelect(action: {guildId?: string; channelId?: string | null; messageId?: string}): boolean {
		const channelId = action.channelId ?? action.guildId;
		if (channelId == null || channelId === ME) {
			return false;
		}
		const currentChannel = Channels.getChannel(channelId);
		const messages = ChannelMessages.getOrCreate(channelId);
		if (action.messageId) {
			const stashed = this.takePendingJumpDispatch(channelId, action.messageId);
			const dispatch: PendingJumpDispatch = stashed ?? {
				messageId: action.messageId,
				flash: true,
				jumpType: JumpTypes.INSTANT,
			};
			if (!GatewaySessions.foregroundConnection.isConnected) {
				this.pendingJumpDispatches.set(channelId, dispatch);
				return true;
			}
			MessageCommands.jumpToMessage({channelId, ...dispatch});
			return false;
		}
		if (!GatewaySessions.foregroundConnection.isConnected || messages.loadingMore || this.hasLoadedPage(messages)) {
			if (this.hasLoadedPage(messages) && Dimension.channelPinnedToEnd(channelId)) {
				this.commitMessages(messages.trimOldest(MAX_MESSAGES_PER_CHANNEL));
				this.notifyChange();
			}
			return false;
		}
		const isPrivateChannel = currentChannel?.isPrivate() ?? false;
		const isNonGuildChannel = action.guildId == null || action.guildId === ME || isPrivateChannel;
		const isFavoritesGuild = action.guildId === FAVORITES_GUILD_ID;
		let guildExists = false;
		if (isFavoritesGuild && !isPrivateChannel) {
			const channelGuildId = currentChannel?.guildId;
			guildExists = channelGuildId ? !!Guilds.getGuild(channelGuildId) : false;
		} else if (action.guildId && !isPrivateChannel) {
			guildExists = !!Guilds.getGuild(action.guildId);
		}
		if (!isNonGuildChannel && !guildExists) {
			return false;
		}
		this.commitMessages(messages.withPatch({loadingMore: true}));
		this.notifyChange();
		MessageCommands.fetchMessages(channelId, null, null, MAX_MESSAGES_PER_CHANNEL);
		return false;
	}

	handleGuildUnavailable(guildId: string, unavailable: boolean): boolean {
		if (!unavailable) {
			return false;
		}
		let didUpdate = false;
		const selectedChannelId = SelectedChannel.currentChannelId;
		let selectedChannelAffected = false;
		ChannelMessages.forEach(({channelId}) => {
			const channel = Channels.getChannel(channelId);
			if (channel && channel.guildId === guildId) {
				this.clearMessages(channelId);
				Dimension.forgetChannelDimensions(channelId);
				didUpdate = true;
				if (channelId === selectedChannelId) {
					selectedChannelAffected = true;
				}
			}
		});
		if (selectedChannelAffected) {
			this.pendingFullHydration = true;
		}
		if (didUpdate) {
			this.notifyChange();
		}
		return didUpdate;
	}

	handleGuildCreate(action: {
		guild: {
			id: string;
		};
	}): boolean {
		if (SelectedGuild.selectedGuildId !== action.guild.id) {
			return false;
		}
		const selectedChannelId = SelectedChannel.selectedChannelIds.get(action.guild.id);
		if (!selectedChannelId) {
			return false;
		}
		const currentMessages = ChannelMessages.get(selectedChannelId);
		const didChannelSelect = this.handleChannelSelect({
			guildId: action.guild.id,
			channelId: selectedChannelId,
			messageId: undefined,
		});
		if (!didChannelSelect && currentMessages && currentMessages.length === 0 && !currentMessages.ready) {
			this.commitMessages(currentMessages.withPatch({loadingMore: true}));
			MessageCommands.fetchMessages(selectedChannelId, null, null, MAX_MESSAGES_PER_CHANNEL);
			this.notifyChange();
			return true;
		}
		return didChannelSelect;
	}

	/** 普通加载接管窗口，旧浏览补拉不得覆盖新的阅读意图 */
	handleLoadMessages(action: {channelId: string; jump?: JumpOptions}): boolean {
		this.watchRefreshes.delete(action.channelId);
		const messages = ChannelMessages.getOrCreate(action.channelId);
		this.commitMessages(messages.beginLoad(action.jump));
		this.notifyChange();
		return false;
	}

	/** 缓存跳转与翻页同样接管窗口并使旧浏览补拉失效 */
	handleLoadMessagesSuccessCached(action: {
		channelId: string;
		jump?: JumpOptions;
		before?: string;
		after?: string;
		limit: number;
	}): boolean {
		this.watchRefreshes.delete(action.channelId);
		let messages = ChannelMessages.getOrCreate(action.channelId);
		if (action.jump?.present) {
			messages = messages.jumpToLiveEdge(action.limit);
		} else if (action.jump?.messageId) {
			messages = messages.jumpToMessage({
				messageId: action.jump.messageId,
				flash: action.jump.flash,
				offset: action.jump.offset,
				returnToMessageId: action.jump.returnToMessageId,
				returnChannelId: action.jump.returnChannelId,
				returnGuildId: action.jump.returnGuildId,
				jumpType: action.jump.jumpType,
			});
		} else if (action.before || action.after) {
			messages = messages.drainBufferedSide(action.before != null, action.limit);
		}
		this.commitMessages(messages);
		this.notifyChange();
		return false;
	}

	/** 提交普通加载结果，避免较早的浏览补拉再次替换当前窗口 */
	handleLoadMessagesSuccess(action: {
		channelId: string;
		isBefore?: boolean;
		isAfter?: boolean;
		jump?: JumpOptions;
		hasMoreBefore?: boolean;
		hasMoreAfter?: boolean;
		cached?: boolean;
		messages: Array<WireMessage>;
	}): boolean {
		this.watchRefreshes.delete(action.channelId);
		const messages = ChannelMessages.getOrCreate(action.channelId).applyLoadedWindow({
			windowMessages: action.messages,
			isBefore: action.isBefore,
			isAfter: action.isAfter,
			jump: action.jump,
			hasMoreBefore: action.hasMoreBefore,
			hasMoreAfter: action.hasMoreAfter,
			cached: action.cached,
		});
		this.commitMessages(messages);
		this.notifyChange();
		this.refetchStaleWindow(action.channelId, action.cached === true, action.jump);
		return false;
	}

	private refetchStaleWindow(channelId: string, stale: boolean, jump?: JumpOptions): void {
		if (!stale || !GatewaySessions.foregroundConnection.isConnected || SelectedChannel.currentChannelId !== channelId) {
			return;
		}
		const lastAttemptAt = staleWindowRefetchedAt.get(channelId) ?? 0;
		const now = Date.now();
		if (now - lastAttemptAt < STALE_WINDOW_REFETCH_INTERVAL_MS) {
			return;
		}
		staleWindowRefetchedAt.set(channelId, now);
		MessageCommands.fetchMessages(channelId, null, null, MAX_MESSAGES_PER_CHANNEL, jump, {staleRefetch: true});
	}

	handleLoadMessagesFailure(action: {channelId: string}): boolean {
		const messages = ChannelMessages.getOrCreate(action.channelId);
		this.commitMessages(messages.withPatch({loadingMore: false, error: true}));
		this.notifyChange();
		return false;
	}

	handleLoadMessagesBlocked(action: {channelId: string}): boolean {
		const messages = ChannelMessages.getOrCreate(action.channelId);
		if (!messages.loadingMore && !messages.error) {
			return false;
		}
		this.commitMessages(messages.withPatch({loadingMore: false, error: false}));
		this.notifyChange();
		return true;
	}

	/** 应用实时新增消息并记录与浏览恢复并发的变化 */
	handleIncomingMessage(action: {channelId: string; message: WireMessage}): boolean {
		this.recordWatchEvent(action.channelId, action.message, [], true);
		Channels.handleMessageCreate({message: action.message});
		const existing = ChannelMessages.get(action.channelId);
		if (!existing?.ready) {
			return false;
		}
		const updated = existing.applyIncomingMessage(action.message, Dimension.channelPinnedToEnd(action.channelId));
		this.commitMessages(updated);
		this.notifyChange();
		return false;
	}

	/** 为一次网络刷新记录并发事件，不重复触发通知或已读更新 */
	beginWatchRefresh(channelId: string): WatchWindowRefresh {
		const refresh: WatchWindowRefresh = {
			baseline: ChannelMessages.get(channelId),
			updates: new Map(),
			deleted: new Set(),
			created: new Set(),
			reactions: new Map(),
			overflowed: false,
		};
		this.watchRefreshes.set(channelId, refresh);
		return refresh;
	}

	/** 合并权威快照与实时事件，窗口被接管时返回未完成以便重新补拉 */
	completeWatchRefresh(
		channelId: string,
		refresh: WatchWindowRefresh,
		snapshot: Array<WireMessage>,
		hasMoreBefore: boolean,
		hasMoreAfter: boolean,
		upperBound: string | null,
	): boolean {
		if (this.watchRefreshes.get(channelId) !== refresh) return false;
		if (refresh.overflowed) throw new Error('帖子恢复期间的事件过多，需要重新获取窗口');
		const current = ChannelMessages.getOrCreate(channelId);
		const byId = new Map(snapshot.map((wire) => [wire.id, wire]));
		for (const id of refresh.created) {
			if (refresh.deleted.has(id)) continue;
			// 历史窗口不拼接远处的新消息，但必须保留继续向后补拉的入口
			if (upperBound && BigInt(id) > BigInt(upperBound)) {
				hasMoreAfter = true;
				continue;
			}
			const wire = refresh.updates.get(id);
			if (wire?.author) byId.set(id, wire as WireMessage);
		}
		for (const [id, wire] of byId) {
			if (refresh.deleted.has(id)) {
				byId.delete(id);
				continue;
			}
			const live = current.get(id);
			const changed = live && live !== refresh.baseline?.get(id);
			const update = refresh.updates.get(id);
			// 同时保留反应变化，并优先使用更新版本的编辑内容
			const candidate = changed ? live.toJSON() : wire;
			const snapshotEdited = Date.parse(wire.edited_timestamp ?? '') || 0;
			const liveEdited = Date.parse(candidate.edited_timestamp ?? '') || 0;
			const base = snapshotEdited > liveEdited ? wire : candidate;
			const updateEdited = Date.parse(update?.edited_timestamp ?? '') || 0;
			const merged = update && updateEdited >= snapshotEdited ? {...base, ...update} : base;
			byId.set(id, refresh.reactions.has(id) ? {...merged, reactions: refresh.reactions.get(id)} : merged);
		}
		const rows = [...byId.values()].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
		this.commitMessages(current.reconcileWatchWindow(rows, hasMoreBefore, hasMoreAfter));
		this.notifyChange();
		return true;
	}

	/** 请求结束后只释放自己的事件记录，不能清掉较新刷新 */
	endWatchRefresh(channelId: string, refresh: WatchWindowRefresh): void {
		if (this.watchRefreshes.get(channelId) === refresh) this.watchRefreshes.delete(channelId);
	}

	/** 只在恢复期间保留有界并发事件，避免高频帖子无限分配内存 */
	private recordWatchEvent(
		channelId: string,
		update: Partial<WireMessage> | null,
		deleted: Array<string>,
		created = false,
	): void {
		const refresh = this.watchRefreshes.get(channelId);
		if (!refresh || refresh.overflowed) return;
		if (refresh.updates.size + refresh.deleted.size + deleted.length >= 1024) {
			refresh.overflowed = true;
			return;
		}
		for (const id of deleted) refresh.deleted.add(id);
		if (update?.id) {
			refresh.updates.set(update.id, {...refresh.updates.get(update.id), ...update});
			if (created) refresh.created.add(update.id);
		}
	}

	/** 单独保存反应变化，避免较新正文快照覆盖并发反应事件 */
	private recordWatchReactions(channelId: string, messageId: string, messages: ChannelMessages): void {
		const refresh = this.watchRefreshes.get(channelId);
		const message = messages.get(messageId);
		if (!refresh || !message || refresh.overflowed) return;
		if (refresh.reactions.size >= 1024) {
			refresh.overflowed = true;
			return;
		}
		refresh.reactions.set(messageId, message.toJSON().reactions);
	}

	handleSendFailed(action: {channelId: string; nonce: string}): boolean {
		const existing = ChannelMessages.get(action.channelId);
		if (!existing?.has(action.nonce)) return false;
		const updated = existing.update(action.nonce, (message) => message.withUpdates({state: MessageStates.FAILED}));
		this.commitMessages(updated);
		this.notifyChange();
		return true;
	}

	handleSendRetry(action: {channelId: string; messageId: string}): boolean {
		const existing = ChannelMessages.get(action.channelId);
		if (!existing?.has(action.messageId)) return false;
		const updated = existing.update(action.messageId, (message) => message.withUpdates({state: MessageStates.SENDING}));
		this.commitMessages(updated);
		this.notifyChange();
		return true;
	}

	/** 删除消息并保留恢复期间的删除标记 */
	handleMessageDelete(action: {id: string; channelId: string}): boolean {
		this.recordWatchEvent(action.channelId, null, [action.id]);
		const existing = ChannelMessages.get(action.channelId);
		if (!existing?.has(action.id)) {
			return false;
		}
		let messages = existing;
		if (messages.unblurredMessageId === action.id) {
			const messageAfter = messages.nextAfter(action.id);
			messages = messages.withPatch({unblurredMessageId: messageAfter?.id ?? null});
		}
		messages = messages.remove(action.id);
		this.commitMessages(messages);
		this.notifyChange();
		return true;
	}

	/** 批量删除消息并阻止旧网络快照重新插入它们 */
	handleMessageDeleteBulk(action: {ids: Array<string>; channelId: string}): boolean {
		this.recordWatchEvent(action.channelId, null, action.ids);
		const existing = ChannelMessages.get(action.channelId);
		if (!existing) return false;
		let messages = existing.removeIds(action.ids);
		if (messages === existing) return false;
		if (messages.unblurredMessageId != null && action.ids.includes(messages.unblurredMessageId)) {
			const after = messages.nextAfter(messages.unblurredMessageId);
			messages = messages.withPatch({unblurredMessageId: after?.id ?? null});
		}
		this.commitMessages(messages);
		this.notifyChange();
		return true;
	}

	/** 应用实时编辑并为并发恢复保留最新字段 */
	handleMessageUpdate(action: {message: WireMessage}): boolean {
		const messageId = action.message.id;
		const channelId = action.message.channel_id;
		this.recordWatchEvent(channelId, action.message, []);
		const existing = ChannelMessages.get(channelId);
		if (!existing?.has(messageId)) return false;
		const updated = existing.update(messageId, (message) => {
			if (message.isEditing && action.message.state === undefined) {
				return message.withUpdates({...action.message, state: MessageStates.SENT});
			}
			return message.withUpdates(action.message);
		});
		this.commitMessages(updated);
		this.notifyChange();
		return true;
	}

	handleUserUpdate(action: {
		user: {
			id: string;
		};
	}): boolean {
		const userId = action.user.id;
		const updatedAuthor = Users.getUser(userId);
		if (!updatedAuthor) return false;
		const authorJson = updatedAuthor.toJSON();
		const hasChanges = this.patchAuthorMessages(userId, (message) => message.withUpdates({author: authorJson}));
		if (hasChanges) {
			this.notifyChange();
		}
		return hasChanges;
	}

	handleGuildMemberUpdate(action: GuildMemberUpdateAction): boolean {
		const userId = action.member.user.id;
		const updatedAuthor = Users.getUser(userId);
		if (!updatedAuthor) return false;
		const authorJson = updatedAuthor.toJSON();
		const hasChanges = this.patchAuthorMessages(userId, (message) => message.withUpdates({author: authorJson}), {
			guildId: action.guildId,
		});
		if (hasChanges) {
			this.notifyChange();
		}
		return hasChanges;
	}

	handleGuildThreadsPurged(guildId: string): void {
		ChannelMessages.forEach(({channelId}) => {
			if (Channels.getChannel(channelId)?.guildId === guildId) {
				this.clearMessages(channelId);
				Dimension.forgetChannelDimensions(channelId);
			}
		});
	}

	handleCleanup(): boolean {
		ChannelMessages.forEach(({channelId}) => {
			if (Channels.getChannel(channelId) == null) {
				this.clearMessages(channelId);
				Dimension.forgetChannelDimensions(channelId);
			}
		});
		this.notifyChange();
		return false;
	}

	handleRelationshipUpdate(): boolean {
		let hasChanges = false;
		ChannelMessages.forEach((messages) => {
			const next = messages.patchMatching(
				(message) => message.blocked !== Relationships.isBlocked(message.author.id),
				(message) => message.withUpdates({blocked: Relationships.isBlocked(message.author.id)}),
			);
			if (next !== null) {
				this.commitMessages(next);
				hasChanges = true;
			}
		});
		if (hasChanges) this.notifyChange();
		return false;
	}

	handleMessageReveal(action: {channelId: string; messageId: string | null}): boolean {
		const messages = ChannelMessages.getOrCreate(action.channelId);
		this.commitMessages(messages.withPatch({unblurredMessageId: action.messageId}));
		this.notifyChange();
		return true;
	}

	handleClearJumpTarget(action: {channelId: string; clearReturnTarget?: boolean}): boolean {
		const messages = ChannelMessages.get(action.channelId);
		if (
			messages &&
			(messages.jumpDestinationId != null ||
				messages.hasJumped ||
				(action.clearReturnTarget === true && messages.jumpReturnMessageId != null))
		) {
			this.commitMessages(messages.clearJumpTarget({clearReturnTarget: action.clearReturnTarget}));
			this.notifyChange();
			return true;
		}
		return false;
	}

	/** 更新反应状态并记录恢复期间的反应快照 */
	handleReaction(action: {
		type: 'MESSAGE_REACTION_ADD' | 'MESSAGE_REACTION_REMOVE';
		channelId: string;
		messageId: string;
		userId: string;
		emoji: ReactionEmoji;
		optimistic?: boolean;
	}): boolean {
		const existing = ChannelMessages.get(action.channelId);
		if (!existing) return false;
		const currentUser = Users.getCurrentUser();
		const isCurrentUser = currentUser?.id === action.userId;
		if (action.optimistic && !isCurrentUser) return false;
		const updated = existing.update(action.messageId, (message) => message.withUpdates({}));
		this.recordWatchReactions(action.channelId, action.messageId, updated);
		this.commitMessages(updated);
		this.notifyChange();
		return true;
	}

	/** 清空反应并防止恢复快照覆盖实时删除 */
	handleRemoveAllReactions(action: {channelId: string; messageId: string}): boolean {
		const existing = ChannelMessages.get(action.channelId);
		if (!existing) return false;
		const updated = existing.update(action.messageId, (message) => message.withUpdates({reactions: []}));
		this.recordWatchReactions(action.channelId, action.messageId, updated);
		this.commitMessages(updated);
		this.notifyChange();
		return true;
	}

	/** 删除指定反应并保留与窗口恢复并发的结果 */
	handleRemoveReactionEmoji(action: {channelId: string; messageId: string; emoji: ReactionEmoji}): boolean {
		const existing = ChannelMessages.get(action.channelId);
		if (!existing) return false;
		const updated = existing.update(action.messageId, (message) => message.withoutReactionEmoji(action.emoji));
		this.recordWatchReactions(action.channelId, action.messageId, updated);
		this.commitMessages(updated);
		this.notifyChange();
		return true;
	}

	handleMessagePreload(action: {messages: Record<ChannelId, WireMessage>}): boolean {
		let hasChanges = false;
		for (const [channelId, messageData] of Object.entries(action.messages)) {
			if (!messageData?.id || !messageData.author) continue;
			Channels.handleMessageCreate({message: messageData});
			const channelMessages = ChannelMessages.getOrCreate(channelId);
			if (!channelMessages.has(messageData.id)) {
				this.commitMessages(channelMessages.applyIncomingMessage(messageData, false));
				hasChanges = true;
			}
		}
		if (hasChanges) {
			this.notifyChange();
		}
		return hasChanges;
	}

	subscribe(callback: () => void): () => void {
		return reaction(
			() => this.version,
			() => callback(),
			{fireImmediately: true},
		);
	}
}

const messages = new Messages();

AccountScopedWork.registerTransition({
	suspend: () => {},
	resume: () => {},
	released: () => {
		if (GatewaySessions.foregroundConnection.isReady) {
			messages.handleGatewayReady();
		}
	},
});

export default messages;
