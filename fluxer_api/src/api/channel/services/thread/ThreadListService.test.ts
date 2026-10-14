// SPDX-License-Identifier: AGPL-3.0-or-later

import {type ChannelID, createChannelID, createGuildID, createUserID} from '@app/api/BrandedTypes';
import {ThreadListService} from '@app/api/channel/services/thread/ThreadListService';
import type {ThreadServiceContext} from '@app/api/channel/services/thread/ThreadServiceContext';
import type {ThreadViewer} from '@app/api/experiment/ChannelThreadsGate';
import type {ThreadState} from '@app/api/models/ThreadState';
import {ChannelTypes, Permissions} from '@fluxer/constants/src/ChannelConstants';
import {describe, expect, test, vi} from 'vitest';

// 目录测试只替换响应映射，保留实际的筛选、鉴权和分页代码
vi.mock('@app/api/channel/services/thread/ThreadMappers', () => ({
	mapThreadToResponse: (view: {state: ThreadState}) => ({id: view.state.threadId.toString()}),
	mapThreadMemberToResponse: (member: {threadId: ChannelID}) => ({id: member.threadId.toString()}),
}));
vi.mock('@app/api/channel/services/thread/ThreadViews', () => ({
	loadThreadViews: async (_repository: unknown, states: Array<ThreadState>) => states.map((state) => ({state})),
}));
vi.mock('@app/api/channel/services/thread/ThreadDenials', () => ({
	assertThreadAllowed: (denial: unknown) => {
		if (denial !== null) throw new Error('线程访问被拒绝');
	},
}));
vi.mock('@fluxer/errors/src/domains/channel/InvalidChannelTypeError', () => ({
	InvalidChannelTypeError: class extends Error {},
}));

const GUILD_ID = createGuildID(1n);
const USER_ID = createUserID(10n);
const TEXT_ID = createChannelID(100n);
const FORUM_ID = createChannelID(200n);
const MEDIA_ID = createChannelID(201n);
const VIEWER = {} as ThreadViewer;

/** 构造用于目录筛选的最小线程状态 */
function createState(id: number, parentId: ChannelID, archived = false): ThreadState {
	// 使用不同归档时间验证排序和下一页游标
	return {
		threadId: createChannelID(BigInt(id)),
		parentId,
		guildId: GUILD_ID,
		isPrivate: false,
		archived,
		archiveTimestamp: new Date(Date.UTC(2026, 0, id)),
		createdAt: new Date(Date.UTC(2026, 0, 1)),
	} as ThreadState;
}

/** 用小规模仓储替身验证业务规则，避免依赖压测实例 */
function createService(states: Array<ThreadState>, joined: Array<ChannelID>): ThreadListService {
	const forum = {id: FORUM_ID, guildId: GUILD_ID, type: ChannelTypes.GUILD_FORUM};
	const context = {
		gatewayService: {
			getGuildData: async () => ({owner_id: USER_ID.toString()}),
			getViewableChannels: async () => [TEXT_ID, FORUM_ID, MEDIA_ID],
		},
		channelRepository: {
			threads: {
				listActiveThreads: async () => states,
				listJoinedThreadIds: async () => joined,
				getMember: async (threadId: ChannelID) => (joined.includes(threadId) ? {threadId, userId: USER_ID} : null),
				getStates: async (ids: Array<ChannelID>) => states.filter((state) => ids.includes(state.threadId)),
			},
			channelData: {
				listChannels: async () => [
					{id: TEXT_ID, type: ChannelTypes.GUILD_TEXT},
					forum,
					{id: MEDIA_ID, type: ChannelTypes.GUILD_MEDIA},
				],
			},
		},
		channelAuth: {
			getChannelAuthenticated: async () => ({channel: forum, guild: {owner_id: USER_ID.toString()}, member: null}),
		},
		parentActor: async () => ({permissions: Permissions.READ_MESSAGE_HISTORY, isOwner: true, timedOut: false}),
	} as unknown as ThreadServiceContext;
	return new ThreadListService(context);
}

describe('ThreadListService 论坛目录规则', () => {
	test('保留未加入的普通线程，但对社区所有者隐藏未加入的论坛和媒体帖子', async () => {
		const service = createService(
			[
				createState(1, TEXT_ID),
				createState(2, FORUM_ID),
				createState(3, FORUM_ID),
				createState(4, MEDIA_ID),
				createState(5, MEDIA_ID),
			],
			[createChannelID(3n), createChannelID(5n)],
		);
		const result = await service.listGuildActive({guildId: GUILD_ID, userId: USER_ID});
		expect(result.threads.map((thread) => thread.id)).toEqual(['5', '3', '1']);
	});

	test('在成员过滤后分页，并只用已加入帖子计算 has_more', async () => {
		const service = createService(
			[
				createState(9, FORUM_ID, true),
				createState(8, FORUM_ID, true),
				createState(7, FORUM_ID, true),
				createState(6, FORUM_ID, true),
				createState(5, TEXT_ID, true),
			],
			[8n, 7n, 6n, 5n].map(createChannelID),
		);
		const first = await service.listPublicArchived({userId: USER_ID, channelId: FORUM_ID, viewer: VIEWER, limit: 2});
		expect(first.threads.map((thread) => thread.id)).toEqual(['8', '7']);
		expect(first.has_more).toBe(true);

		const next = await service.listPublicArchived({
			userId: USER_ID,
			channelId: FORUM_ID,
			viewer: VIEWER,
			before: new Date(Date.UTC(2026, 0, 7)),
			limit: 2,
		});
		expect(next.threads.map((thread) => thread.id)).toEqual(['6']);
		expect(next.has_more).toBe(false);
	});
});
