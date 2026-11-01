// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createMultipartFormData} from '@app/api/channel/tests/AttachmentTestUtils';
import {
	acceptInvite,
	addMemberRole,
	createChannel,
	createChannelInvite,
	createGuild,
	createRole,
} from '@app/api/channel/tests/ChannelTestUtils';
import {THREADS_FEATURE, THREADS_FEATURE_HEADER, threadsRequest} from '@app/api/channel/tests/ThreadTestUtils';
import {clearChannelThreadsTaintCacheForTesting} from '@app/api/experiment/ChannelThreadsGate';
import {ensureSessionStarted} from '@app/api/message/tests/MessageTestUtils';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {NoopGatewayService} from '@app/api/test/NoopGatewayService';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {ChannelTypes, Permissions} from '@fluxer/constants/src/ChannelConstants';
import {ChannelFlags} from '@fluxer/constants/src/ThreadConstants';
import type {ChannelResponse} from '@fluxer/schema/src/domains/channel/ChannelSchemas';
import type {
	StartForumThreadResponse,
	ThreadPostDataResponse,
} from '@fluxer/schema/src/domains/channel/ForumRequestSchemas';
import type {ThreadChannelResponse} from '@fluxer/schema/src/domains/channel/ThreadRequestSchemas';
import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

interface Setup {
	owner: TestAccount;
	member: TestAccount;
	guildId: string;
	forumId: string;
}

const PNG_1X1 = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
	'base64',
);

describe('forum and media channels', () => {
	let harness: ApiTestHarness;

	beforeAll(async () => {
		harness = await createApiTestHarness();
	});

	beforeEach(async () => {
		await harness.reset();
		clearChannelThreadsTaintCacheForTesting();
	});

	afterAll(async () => {
		clearChannelThreadsTaintCacheForTesting();
		await harness.shutdown();
	});

	async function createForum(
		token: string,
		guildId: string,
		body: Record<string, unknown> = {},
		type: number = ChannelTypes.GUILD_FORUM,
	): Promise<ChannelResponse> {
		return threadsRequest<ChannelResponse>(harness, token)
			.post(`/guilds/${guildId}/channels`)
			.body({name: 'forum', type, ...body})
			.execute();
	}

	async function setup(forumBody: Record<string, unknown> = {}): Promise<Setup> {
		const owner = await createTestAccount(harness);
		const member = await createTestAccount(harness);
		await ensureSessionStarted(harness, owner.token);
		await ensureSessionStarted(harness, member.token);
		const guild = await createGuild(harness, owner.token, 'forums');
		const general = await createChannel(harness, owner.token, guild.id, 'general');
		const invite = await createChannelInvite(harness, owner.token, general.id);
		await acceptInvite(harness, member.token, invite.code);
		const forum = await createForum(owner.token, guild.id, forumBody);
		return {owner, member, guildId: guild.id, forumId: forum.id};
	}

	async function post(
		token: string,
		forumId: string,
		body: Record<string, unknown> = {},
		status = 201,
	): Promise<StartForumThreadResponse> {
		return threadsRequest<StartForumThreadResponse>(harness, token)
			.post(`/channels/${forumId}/threads`)
			.body({name: 'post', message: {content: 'hello'}, ...body})
			.expect(status)
			.execute();
	}

	describe('control arm', () => {
		it('rejects creating forums without the client capability', async () => {
			const owner = await createTestAccount(harness);
			const guild = await createGuild(harness, owner.token, 'control');
			const body = {name: 'forum', type: ChannelTypes.GUILD_FORUM, available_tags: [{name: 'a'}]};
			const control = await harness.requestJson({
				path: `/guilds/${guild.id}/channels`,
				method: 'POST',
				headers: {Authorization: owner.token},
				body,
			});
			expect(control.status).toBe(400);
		});
	});

	describe('settings', () => {
		it('keeps every tag when tag creates race', async () => {
			const s = await setup();
			const names = ['a', 'b', 'c', 'd', 'e'];
			await Promise.all(
				names.map((name) =>
					threadsRequest<ChannelResponse>(harness, s.owner.token)
						.post(`/channels/${s.forumId}/tags`)
						.body({name})
						.execute(),
				),
			);
			const forum = await threadsRequest<ChannelResponse>(harness, s.owner.token)
				.get(`/channels/${s.forumId}`)
				.execute();
			expect(forum.available_tags!.map((tag) => tag.name).sort()).toEqual(names);
		});
	});

	describe('posts', () => {
		it('refuses a limited account before creating the post', async () => {
			const s = await setup();
			await createBuilder(harness, '')
				.post(`/test/users/${s.member.userId}/security-flags`)
				.body({set_flags: ['ACCOUNT_LIMITED']})
				.execute();
			await threadsRequest(harness, s.member.token)
				.post(`/channels/${s.forumId}/threads`)
				.body({name: 'limited', message: {content: 'hello'}})
				.expect(403, APIErrorCodes.ACCOUNT_LIMITED)
				.execute();
			const forum = await threadsRequest<ChannelResponse>(harness, s.owner.token)
				.get(`/channels/${s.forumId}`)
				.execute();
			expect(forum.last_message_id ?? null).toBeNull();
		});

		it('rolls back a post whose starter fails after the thread exists', async () => {
			const s = await setup({rate_limit_per_user: 60});
			const first = await post(s.owner.token, s.forumId);
			await post(s.member.token, s.forumId, {message: {content: 'x', sticker_ids: ['1']}}, 400);
			const forum = await threadsRequest<ChannelResponse>(harness, s.owner.token)
				.get(`/channels/${s.forumId}`)
				.execute();
			expect(forum.last_message_id).toBe(first.id);
			await post(s.member.token, s.forumId);
		});

		it('requires send messages on the forum and refuses private posts', async () => {
			const s = await setup();
			await post(s.member.token, s.forumId, {type: ChannelTypes.PRIVATE_THREAD}, 400);
			const role = await createRole(harness, s.owner.token, s.guildId, {name: 'muted'});
			await addMemberRole(harness, s.owner.token, s.guildId, s.member.userId, role.id);
			await threadsRequest(harness, s.owner.token)
				.put(`/channels/${s.forumId}/permissions/${role.id}`)
				.body({type: 0, allow: '0', deny: Permissions.SEND_MESSAGES.toString()})
				.expect(204)
				.execute();
			await post(s.member.token, s.forumId, {}, 403);
		});

		it('accepts a multipart post with a file', async () => {
			const s = await setup();
			const {body, contentType} = createMultipartFormData(
				{name: 'files', message: {content: 'with file', attachments: [{id: 0, filename: 'a.png'}]}},
				[{index: 0, filename: 'a.png', data: PNG_1X1}],
			);
			const response = await harness.app.request(`/channels/${s.forumId}/threads`, {
				method: 'POST',
				headers: {
					Authorization: s.member.token,
					[THREADS_FEATURE_HEADER]: THREADS_FEATURE,
					'Content-Type': contentType,
					'x-forwarded-for': '127.0.0.1',
				},
				body,
			});
			expect(response.status).toBe(201);
			const created = (await response.json()) as StartForumThreadResponse;
			expect(created.message?.id).toBe(created.id);
			expect(created.message?.attachments).toHaveLength(1);
		});

		it('allows one pinned post and clears the pin on archive', async () => {
			const s = await setup();
			const first = await post(s.owner.token, s.forumId);
			const second = await post(s.owner.token, s.forumId);
			const pinned = await threadsRequest<ThreadChannelResponse>(harness, s.owner.token)
				.patch(`/channels/${first.id}`)
				.body({flags: ChannelFlags.PINNED})
				.execute();
			expect(pinned.flags).toBe(ChannelFlags.PINNED);
			await threadsRequest(harness, s.owner.token)
				.patch(`/channels/${second.id}`)
				.body({flags: ChannelFlags.PINNED})
				.expect(400, APIErrorCodes.MAX_PINNED_THREADS_IN_FORUM)
				.execute();
			const archived = await threadsRequest<ThreadChannelResponse>(harness, s.owner.token)
				.patch(`/channels/${first.id}`)
				.body({archived: true})
				.execute();
			expect(archived.flags).toBe(0);
			await threadsRequest(harness, s.owner.token)
				.patch(`/channels/${second.id}`)
				.body({flags: ChannelFlags.PINNED})
				.execute();
			await threadsRequest(harness, s.member.token)
				.patch(`/channels/${second.id}`)
				.body({flags: 0})
				.expect(403)
				.execute();
		});

		it('returns post data', async () => {
			const s = await setup();
			const created = await post(s.member.token, s.forumId);
			const data = await threadsRequest<ThreadPostDataResponse>(harness, s.owner.token)
				.post(`/channels/${s.forumId}/post-data`)
				.body({thread_ids: [created.id, '1']})
				.execute();
			expect(Object.keys(data.threads)).toEqual([created.id]);
			expect(data.threads['1']).toBeUndefined();
			expect(data.threads[created.id]?.owner?.user.id).toBe(s.member.userId);
			expect(data.threads[created.id]?.first_message?.id).toBe(created.id);
		});

		it('applies the forum slowmode to post creation', async () => {
			const s = await setup({rate_limit_per_user: 60});
			await post(s.member.token, s.forumId);
			const state = await threadsRequest<{retry_after_ms: number}>(harness, s.member.token)
				.get(`/channels/${s.forumId}/slowmode`)
				.execute();
			expect(state.retry_after_ms).toBeGreaterThan(0);
			await threadsRequest(harness, s.member.token)
				.post(`/channels/${s.forumId}/threads`)
				.body({name: 'again', message: {content: 'x'}})
				.expect(400, APIErrorCodes.SLOWMODE_RATE_LIMITED)
				.execute();
		});
	});

	describe('gateway payloads', () => {
		it('carries forum settings on CHANNEL_CREATE and CHANNEL_UPDATE', async () => {
			const s = await setup();
			const dispatches: Array<{event: string; data: unknown}> = [];
			const spy = vi.spyOn(NoopGatewayService.prototype, 'dispatchGuild').mockImplementation(async (params) => {
				dispatches.push({event: params.event, data: params.data});
			});
			await createForum(s.owner.token, s.guildId, {available_tags: [{name: 'x'}]});
			await threadsRequest(harness, s.owner.token).post(`/channels/${s.forumId}/tags`).body({name: 'y'}).execute();
			spy.mockRestore();
			const created = dispatches.find((entry) => entry.event === 'CHANNEL_CREATE')?.data as ChannelResponse;
			const updated = dispatches.find((entry) => entry.event === 'CHANNEL_UPDATE')?.data as ChannelResponse;
			expect(created.available_tags?.map((tag) => tag.name)).toEqual(['x']);
			expect(updated.available_tags?.map((tag) => tag.name)).toEqual(['y']);
			expect(updated.default_forum_layout).toBe(0);
		});
	});

	describe('existing routes on forums', () => {
		it('reports thread search as unavailable without a search provider', async () => {
			const s = await setup();
			await threadsRequest(harness, s.member.token)
				.get(`/channels/${s.forumId}/threads/search`)
				.expect(403, APIErrorCodes.FEATURE_TEMPORARILY_DISABLED)
				.execute();
		});

		it('answers with the right errors', async () => {
			const s = await setup();
			await threadsRequest(harness, s.member.token)
				.get(`/channels/${s.forumId}/messages`)
				.expect(400, APIErrorCodes.INVALID_CHANNEL_TYPE)
				.execute();
			await threadsRequest(harness, s.member.token)
				.get(`/channels/${s.forumId}/messages/pins`)
				.expect(400, APIErrorCodes.INVALID_CHANNEL_TYPE)
				.execute();
			await threadsRequest(harness, s.member.token)
				.post(`/channels/${s.forumId}/typing`)
				.expect(400, APIErrorCodes.INVALID_CHANNEL_TYPE)
				.execute();
			await threadsRequest(harness, s.member.token)
				.post(`/channels/${s.forumId}/messages`)
				.body({content: 'x'})
				.expect(400, APIErrorCodes.CANNOT_SEND_MESSAGES_IN_NON_TEXT_CHANNEL)
				.execute();
		});
	});
});
