// SPDX-License-Identifier: AGPL-3.0-or-later

import {type ChannelID, createMessageID, type GuildID, type MessageID, type UserID} from '@app/api/BrandedTypes';
import type {ChannelRepository} from '@app/api/channel/ChannelRepository';
import {mapThreadMemberToRpcResponse, mapThreadToRpcResponse} from '@app/api/channel/services/thread/ThreadMappers';
import {mapThreadParentFields} from '@app/api/channel/services/thread/ThreadParentSettings';
import {loadThreadViews} from '@app/api/channel/services/thread/ThreadViews';
import {getChannelThreadsConfig, isTainted} from '@app/api/experiment/ChannelThreadsGate';
import type {Channel} from '@app/api/models/Channel';
import type {ThreadMember} from '@app/api/models/ThreadMember';
import type {ThreadParentConfig} from '@app/api/models/ThreadParentConfig';
import {mapWithConcurrency} from '@app/api/utils/ConcurrencyUtils';
import {
	FORUM_UNREAD_COUNT_CAP,
	MAX_THREAD_MEMBERS,
	THREAD_ONLY_CHANNEL_TYPES,
} from '@fluxer/constants/src/ThreadConstants';
import type {
	ThreadMemberRpcResponse,
	ThreadParentSettingsRpcResponse,
} from '@fluxer/schema/src/domains/channel/ThreadSchemas';
import {createSnowflakeFromTimestamp, FLUXER_EPOCH} from '@fluxer/snowflake/src/Snowflake';

const MEMBER_PAGE_SIZE = 1000;
const MEMBER_LOAD_CONCURRENCY = 16;

export type ThreadGateRpcData = {thread_gate: {active: boolean; config_version: number}; thread_tainted: boolean};

export interface ThreadCollectionRpcData {
	threads: Array<ReturnType<typeof mapThreadToRpcResponse>>;
	thread_members?: Array<ThreadMemberRpcResponse>;
	thread_parent_settings: Array<ThreadParentSettingsRpcResponse>;
}

export async function resolveThreadGateRpcData(guildId: GuildID): Promise<ThreadGateRpcData | null> {
	return {
		thread_gate: {active: true, config_version: getChannelThreadsConfig().config_version},
		thread_tainted: await isTainted(guildId),
	};
}

/** 批量读取活动或归档帖子的最小可信上下文，避免按浏览会话逐个查询 */
export async function loadThreadWatchContexts(
	repository: ChannelRepository,
	guildId: GuildID,
	threadIds: Array<ChannelID>,
) {
	// 批量状态读取已包含归属和类型，父频道访问权限由网关校验
	const states = await repository.threads.getStates([...new Set(threadIds)]);
	return states
		.filter((state) => state.guildId === guildId && state.type === 11)
		.map((state) => ({
			id: state.threadId.toString(),
			guild_id: state.guildId.toString(),
			parent_id: state.parentId.toString(),
			type: 11 as const,
		}));
}

function mapParentSettingsToRpc(
	parent: Channel,
	config: ThreadParentConfig | null,
): ThreadParentSettingsRpcResponse | null {
	if (config === null && !THREAD_ONLY_CHANNEL_TYPES.has(parent.type)) return null;
	return {channel_id: parent.id.toString(), ...mapThreadParentFields(parent.type, config)};
}

async function listAllMembers(repository: ChannelRepository, threadId: ChannelID): Promise<Array<ThreadMember>> {
	const members: Array<ThreadMember> = [];
	let after: UserID | undefined;
	while (members.length < MAX_THREAD_MEMBERS * 2) {
		const page = await repository.threads.listMembers(threadId, {after, limit: MEMBER_PAGE_SIZE});
		members.push(...page);
		if (page.length < MEMBER_PAGE_SIZE) break;
		after = page[page.length - 1]!.userId;
	}
	return members;
}

export async function loadThreadCollectionRpcData(
	repository: ChannelRepository,
	guildId: GuildID,
	parents: ReadonlyArray<Channel>,
	{members: includeMembers}: {members: boolean},
): Promise<ThreadCollectionRpcData> {
	const [states, parentConfigs] = await Promise.all([
		repository.threads.listActiveThreads(guildId),
		repository.threads.listParentConfigs(guildId),
	]);
	const views = await loadThreadViews(repository, states, parents);
	const members = includeMembers
		? await mapWithConcurrency(views, MEMBER_LOAD_CONCURRENCY, (view) =>
				listAllMembers(repository, view.state.threadId),
			)
		: null;
	const configs = new Map(parentConfigs.map((config) => [config.channelId, config]));
	return {
		threads: views.map(mapThreadToRpcResponse),
		...(members ? {thread_members: members.flat().map(mapThreadMemberToRpcResponse)} : {}),
		thread_parent_settings: parents.flatMap((parent) => {
			const settings = mapParentSettingsToRpc(parent, configs.get(parent.id) ?? null);
			return settings ? [settings] : [];
		}),
	};
}

export async function listThreadMembersPage(
	repository: ChannelRepository,
	params: {guildId: GuildID; threadIds: Array<ChannelID>; limit: number; after?: UserID},
): Promise<{
	members: Array<ThreadMemberRpcResponse>;
	has_more: boolean;
	next_thread_id: string | null;
	next_after_user_id: string | null;
}> {
	const states = await repository.threads.getStates(params.threadIds);
	const inGuild = new Set(states.filter((state) => state.guildId === params.guildId).map((state) => state.threadId));
	const members: Array<ThreadMember> = [];
	let after = params.after;
	for (const threadId of params.threadIds) {
		const cursor = after;
		after = undefined;
		if (!inGuild.has(threadId)) continue;
		const remaining = params.limit - members.length;
		const page = await repository.threads.listMembers(threadId, {after: cursor, limit: remaining + 1});
		if (page.length > remaining) {
			members.push(...page.slice(0, remaining));
			return {
				members: members.map(mapThreadMemberToRpcResponse),
				has_more: true,
				next_thread_id: threadId.toString(),
				next_after_user_id: remaining > 0 ? page[remaining - 1]!.userId.toString() : null,
			};
		}
		members.push(...page);
	}
	return {
		members: members.map(mapThreadMemberToRpcResponse),
		has_more: false,
		next_thread_id: null,
		next_after_user_id: null,
	};
}

export interface ForumUnreadRpcEntry {
	thread_id: string;
	count?: number;
	missing?: true;
}

/** 仅统计授权通过的帖子，并按消息历史截止时间限制计数范围。 */
export async function loadForumUnreads(
	repository: ChannelRepository,
	params: {
		guildId: GuildID;
		channelId: ChannelID;
		threads: Array<{threadId: ChannelID; ackMessageId?: MessageID}>;
		/** 已经按真实频道和线程权限验证的范围。 */
		visibleThreadIds: ReadonlySet<ChannelID>;

		/** 是否可以读取完整消息历史。 */
		canReadMessageHistory: boolean;

		/** 无完整历史权限时允许读取的最早时间。 */
		messageHistoryCutoff: string | null;
	},
): Promise<Array<ForumUnreadRpcEntry>> {
	const cutoff = params.messageHistoryCutoff ? new Date(params.messageHistoryCutoff).getTime() : null;
	const cutoffId =
		cutoff !== null && Number.isFinite(cutoff)
			? createMessageID(createSnowflakeFromTimestamp(Math.max(cutoff, Number(FLUXER_EPOCH))) - 1n)
			: null;
	return Promise.all(
		params.threads
			.filter((thread) => params.visibleThreadIds.has(thread.threadId))
			.map(async ({threadId, ackMessageId}): Promise<ForumUnreadRpcEntry> => {
				if (ackMessageId === undefined) return {thread_id: threadId.toString(), missing: true};
				if (!params.canReadMessageHistory && cutoffId === null) return {thread_id: threadId.toString(), count: 0};
				const after =
					!params.canReadMessageHistory && cutoffId !== null && cutoffId > ackMessageId ? cutoffId : ackMessageId;
				const unread = await repository.messages.listMessages(threadId, undefined, FORUM_UNREAD_COUNT_CAP, after);
				return {thread_id: threadId.toString(), count: unread.length};
			}),
	);
}
