// SPDX-License-Identifier: AGPL-3.0-or-later

import {Routes} from '@app/app/Routes';
import Authentication from '@app/features/auth/state/Authentication';
import {cleanupChannelLocalState} from '@app/features/channel/events/ChannelDelete';
import type {Channel, ChannelWire} from '@app/features/channel/models/Channel';
import Channels from '@app/features/channel/state/Channels';
import GuildReadState from '@app/features/guild/state/GuildReadState';
import Navigation from '@app/features/navigation/state/Navigation';
import * as RouterUtils from '@app/features/navigation/utils/RouterUtils';
import Permission from '@app/features/permissions/state/Permission';
import ReadStates from '@app/features/read_state/state/ReadStates';
import ThreadGuilds from '@app/features/threads/state/ThreadGuilds';
import ThreadMemberships from '@app/features/threads/state/ThreadMemberships';
import {canViewThreadChannel} from '@app/features/threads/utils/ThreadActionRules';
import {Permissions} from '@fluxer/constants/src/ChannelConstants';
import {THREAD_CHANNEL_TYPES} from '@fluxer/constants/src/ThreadConstants';
import type {ThreadMemberResponse} from '@fluxer/schema/src/domains/channel/ThreadSchemas';
import type {Message as WireMessage} from '@fluxer/schema/src/domains/message/MessageResponseSchemas';
import * as SnowflakeUtils from '@fluxer/snowflake/src/SnowflakeUtils';
import {makeAutoObservable, observable} from 'mobx';

const EMPTY_IDS: ReadonlyArray<string> = Object.freeze([]);

export interface ThreadListSyncPayload {
	guild_id: string;
	channel_ids?: ReadonlyArray<string>;
	threads: ReadonlyArray<ChannelWire>;
	members: ReadonlyArray<ThreadMemberResponse>;
}

export interface ThreadDeletePayload {
	id: string;
	guild_id: string;
	parent_id?: string | null;
	type: number;
}

function insertSortedId(ids: ReadonlyArray<string>, id: string): ReadonlyArray<string> {
	if (ids.includes(id)) return ids;
	const next = [...ids, id];
	next.sort(SnowflakeUtils.compare);
	return next;
}

export function lastActivityId(thread: Channel): string {
	return thread.lastMessageId != null && SnowflakeUtils.compare(thread.lastMessageId, thread.id) > 0
		? thread.lastMessageId
		: thread.id;
}

class ChannelThreads {
	private readonly threadIdsByParent = observable.map<string, ReadonlyArray<string>>();
	private readonly threadIdsByGuild = observable.map<string, ReadonlyArray<string>>();
	private readonly parentByThread = new Map<string, {guildId: string; parentId: string}>();
	private readonly directoryReferences = new Map<string, ReadonlySet<string>>();
	// 保留提及消息依赖的模型，关注同步和目录释放不代表失去该消息的访问权限。
	private readonly messageContextReferences = new Set<string>();
	private lifecycleGeneration = 0;
	private mentionReferences: ReadonlySet<string> = new Set();

	constructor() {
		makeAutoObservable<
			this,
			| 'threadIdsByParent'
			| 'threadIdsByGuild'
			| 'parentByThread'
			| 'directoryReferences'
			| 'messageContextReferences'
			| 'lifecycleGeneration'
			| 'mentionReferences'
		>(
			this,
			{
				threadIdsByParent: false,
				threadIdsByGuild: false,
				parentByThread: false,
				directoryReferences: false,
				messageContextReferences: false,
				lifecycleGeneration: false,
				mentionReferences: false,
			},
			{autoBind: true},
		);
	}

	getThreadIdsForParent(parentId: string): ReadonlyArray<string> {
		return this.threadIdsByParent.get(parentId) ?? EMPTY_IDS;
	}

	/** 目录只持有模型引用，退出结果集时释放未加入且未打开的帖子。 */
	setDirectoryReferences(parentId: string, ids: ReadonlySet<string>): void {
		const previous = this.directoryReferences.get(parentId) ?? new Set<string>();
		if (ids.size > 0) this.directoryReferences.set(parentId, ids);
		else this.directoryReferences.delete(parentId);
		for (const id of previous) {
			if (
				ids.has(id) ||
				this.messageContextReferences.has(id) ||
				this.mentionReferences.has(id) ||
				ThreadMemberships.isMember(id) ||
				Navigation.channelId === id ||
				Navigation.threadId === id
			)
				continue;
			this.remove(id);
		}
	}

	/** 提及消息集合持有共享模型，最后一条消息移除时释放没有其他消费者的帖子。 */
	setMentionReferences(ids: ReadonlySet<string>): void {
		const previous = this.mentionReferences;
		this.mentionReferences = ids;
		for (const id of previous) {
			const channel = Channels.getChannel(id);
			if (ids.has(id) || this.messageContextReferences.has(id) || ThreadMemberships.isMember(id)) continue;
			if (Navigation.channelId === id || Navigation.threadId === id) continue;
			if (this.directoryReferences.get(channel?.parentId ?? '')?.has(id)) continue;
			if (channel?.isThread()) this.remove(id);
		}
	}

	/** 删除、失权和重置后禁止在途响应恢复旧模型。 */
	getLifecycleGeneration(): number {
		return this.lifecycleGeneration;
	}

	getGuildThreadIds(guildId: string): ReadonlyArray<string> {
		return this.threadIdsByGuild.get(guildId) ?? EMPTY_IDS;
	}

	hasThread(threadId: string): boolean {
		return this.parentByThread.has(threadId);
	}

	getThread(threadId: string): Channel | undefined {
		const channel = Channels.getChannel(threadId);
		if (!channel?.isThread() || !this.isParentViewable(channel)) return undefined;
		return canViewThreadChannel(channel) ? channel : undefined;
	}

	getThreadsForParent(parentId: string): ReadonlyArray<Channel> {
		const ids = this.threadIdsByParent.get(parentId);
		if (ids == null || ids.length === 0) return [];
		const parent = Channels.getChannel(parentId);
		if (!parent || !Permission.can(Permissions.VIEW_CHANNEL, parent)) return [];
		const threads: Array<Channel> = [];
		for (const id of ids) {
			const thread = Channels.getChannel(id);
			if (thread?.isThread() && canViewThreadChannel(thread)) {
				threads.push(thread);
			}
		}
		return threads;
	}

	getActiveThreadsForParent(parentId: string): ReadonlyArray<Channel> {
		return this.getThreadsForParent(parentId).filter((thread) => !thread.isArchived);
	}

	getSidebarThreads(parentId: string, openThreadId: string | null): ReadonlyArray<Channel> {
		return this.getThreadsForParent(parentId).filter(
			(thread) => thread.id === openThreadId || (!thread.isArchived && ThreadMemberships.isMember(thread.id)),
		);
	}

	getGuildThreads(guildId: string): ReadonlyArray<Channel> {
		const ids = this.threadIdsByGuild.get(guildId);
		if (ids == null || ids.length === 0) return [];
		const threads: Array<Channel> = [];
		for (const id of ids) {
			const thread = this.getThread(id);
			if (thread) threads.push(thread);
		}
		return threads;
	}

	private isParentViewable(thread: Channel): boolean {
		if (!thread.parentId) return false;
		const parent = Channels.getChannel(thread.parentId);
		return parent != null && Permission.can(Permissions.VIEW_CHANNEL, parent);
	}

	private index(guildId: string, parentId: string, threadId: string): void {
		const existing = this.parentByThread.get(threadId);
		if (existing?.parentId === parentId && existing.guildId === guildId) return;
		if (existing) this.unindex(threadId);
		this.parentByThread.set(threadId, {guildId, parentId});
		this.threadIdsByParent.set(parentId, insertSortedId(this.getThreadIdsForParent(parentId), threadId));
		this.threadIdsByGuild.set(guildId, insertSortedId(this.getGuildThreadIds(guildId), threadId));
	}

	private unindex(threadId: string): void {
		const existing = this.parentByThread.get(threadId);
		if (!existing) return;
		this.parentByThread.delete(threadId);
		const byParent = this.getThreadIdsForParent(existing.parentId).filter((id) => id !== threadId);
		if (byParent.length === 0) this.threadIdsByParent.delete(existing.parentId);
		else this.threadIdsByParent.set(existing.parentId, byParent);
		const byGuild = this.getGuildThreadIds(existing.guildId).filter((id) => id !== threadId);
		if (byGuild.length === 0) this.threadIdsByGuild.delete(existing.guildId);
		else this.threadIdsByGuild.set(existing.guildId, byGuild);
	}

	upsert(wire: ChannelWire, guildId?: string, {silent = false}: {silent?: boolean} = {}): Channel | undefined {
		const resolvedGuildId = wire.guild_id ?? guildId;
		if (
			!resolvedGuildId ||
			!ThreadGuilds.isActive(resolvedGuildId) ||
			!wire.parent_id ||
			!THREAD_CHANNEL_TYPES.has(wire.type)
		) {
			return undefined;
		}
		const {member, newly_created: _newlyCreated, ...rest} = wire;
		const existing = Channels.getChannel(wire.id);
		const channel: ChannelWire = {
			...rest,
			guild_id: resolvedGuildId,
			last_message_id: newestId(rest.last_message_id, existing?.lastMessageId),
		};
		Channels.upsertThread(channel);
		this.index(resolvedGuildId, wire.parent_id, wire.id);
		if (member) {
			ThreadMemberships.set(wire.id, member);
		}
		if (silent) return Channels.getChannel(wire.id);
		Permission.handleChannelUpdate(wire.id);
		ReadStates.handleChannelCreate({channel});
		GuildReadState.handleGenericUpdate(wire.id);
		return Channels.getChannel(wire.id);
	}

	remove(threadId: string): void {
		this.lifecycleGeneration++;
		this.messageContextReferences.delete(threadId);
		this.unindex(threadId);
		ThreadMemberships.remove(threadId);
		Channels.removeThread(threadId);
	}

	deleteThread(threadId: string): void {
		this.lifecycleGeneration++;
		this.messageContextReferences.delete(threadId);
		const channel = Channels.getChannel(threadId);
		this.unindex(threadId);
		ThreadMemberships.remove(threadId);
		if (channel?.guildId && channel.parentId && Navigation.channelId === threadId) {
			RouterUtils.replaceWith(Routes.guildChannel(channel.guildId, channel.parentId));
		}
		if (channel) {
			cleanupChannelLocalState(channel.toJSON());
		}
	}

	handleThreadDelete(payload: ThreadDeletePayload): void {
		this.deleteThread(payload.id);
	}

	ingestGuildThreads(guildId: string, threads: ReadonlyArray<ChannelWire>): void {
		const incoming = new Set<string>();
		for (const thread of threads) incoming.add(thread.id);
		for (const threadId of this.getGuildThreadIds(guildId)) {
			if (incoming.has(threadId) || Channels.getChannel(threadId)?.isArchived) continue;
			ThreadMemberships.remove(threadId);
		}
		for (const thread of threads) {
			if (!thread.member) ThreadMemberships.remove(thread.id);
			this.upsert(thread, guildId);
		}
	}

	handleListSync(payload: ThreadListSyncPayload, keepThreadIds: ReadonlySet<string>): void {
		const parents = payload.channel_ids ? new Set(payload.channel_ids) : null;
		const incoming = new Set(payload.threads.map((thread) => thread.id));
		for (const threadId of [...this.getGuildThreadIds(payload.guild_id)]) {
			if (incoming.has(threadId) || keepThreadIds.has(threadId)) continue;
			const channel = Channels.getChannel(threadId);
			if (!channel || channel.isArchived) continue;
			if (parents != null && (channel.parentId == null || !parents.has(channel.parentId))) continue;
			ThreadMemberships.remove(threadId);
			if (
				!this.isParentViewable(channel) ||
				(!this.directoryReferences.get(channel.parentId ?? '')?.has(threadId) &&
					!this.messageContextReferences.has(threadId) &&
					!this.mentionReferences.has(threadId))
			)
				this.remove(threadId);
		}
		const membersByThread = new Map<string, ThreadMemberResponse>();
		for (const member of payload.members) {
			if (member.id) membersByThread.set(member.id, member);
		}
		for (const thread of payload.threads) {
			const member = membersByThread.get(thread.id);
			if (!member) ThreadMemberships.remove(thread.id);
			this.upsert(member ? {...thread, member} : thread, payload.guild_id);
		}
	}

	ingestMessageThreads(messages: ReadonlyArray<WireMessage>): void {
		for (const message of messages) {
			const thread = message.thread as ChannelWire | undefined;
			if (thread == null) continue;
			const guildId = thread.guild_id ?? message.guild_id;
			if (guildId && ThreadGuilds.isActive(guildId)) {
				this.upsert(thread, guildId);
			}
		}
	}

	purgeGuild(guildId: string): ReadonlyArray<string> {
		const threadIds = [...this.getGuildThreadIds(guildId)];
		for (const threadId of threadIds) {
			this.deleteThread(threadId);
		}
		this.threadIdsByGuild.delete(guildId);
		return threadIds;
	}

	handleGuildRemoved(guildId: string): void {
		for (const threadId of [...this.getGuildThreadIds(guildId)]) {
			this.remove(threadId);
		}
	}

	handleParentDelete(parentId: string): void {
		this.directoryReferences.delete(parentId);
		for (const threadId of [...this.getThreadIdsForParent(parentId)]) {
			this.deleteThread(threadId);
		}
	}

	handleGatewayReady(
		guilds: ReadonlyArray<{id: string; unavailable?: boolean; threads?: ReadonlyArray<ChannelWire>}>,
	): void {
		this.threadIdsByParent.clear();
		this.threadIdsByGuild.clear();
		this.parentByThread.clear();
		this.directoryReferences.clear();
		this.messageContextReferences.clear();
		this.lifecycleGeneration++;
		this.mentionReferences = new Set();
		ThreadMemberships.clear();
		for (const guild of guilds) {
			if (guild.unavailable || !guild.threads) continue;
			for (const thread of guild.threads) {
				this.upsert(thread, guild.id, {silent: true});
			}
		}
	}

	isCurrentUser(userId: string | undefined): boolean {
		return userId != null && userId === Authentication.currentUserId;
	}
}

function newestId(a: string | null | undefined, b: string | null | undefined): string | null {
	if (a == null) return b ?? null;
	if (b == null) return a;
	return SnowflakeUtils.compare(a, b) >= 0 ? a : b;
}

export default new ChannelThreads();
