// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createChannelID, createGuildID, createUserID} from '@app/api/BrandedTypes';
import {createTestBotAccount} from '@app/api/bot/tests/BotTestUtils';
import {ChannelRepository} from '@app/api/channel/ChannelRepository';
import {ChannelDataRepository} from '@app/api/channel/repositories/ChannelDataRepository';
import {
	acceptInvite,
	createChannel,
	createChannelInvite,
	createGuild,
	updateChannel,
} from '@app/api/channel/tests/ChannelTestUtils';
import {threadsRequest} from '@app/api/channel/tests/ThreadTestUtils';
import {upsertOne} from '@app/api/database/CassandraQueryExecution';
import {Db} from '@app/api/database/CassandraTypes';
import {clearChannelThreadsTaintCacheForTesting} from '@app/api/experiment/ChannelThreadsGate';
import {markGuildChannelsAsIndexed, sendMessage} from '@app/api/message/tests/MessageTestUtils';
import {getInstanceConfigRepository} from '@app/api/middleware/ServiceSingletons';
import {drainSearchTasks} from '@app/api/search/SearchTaskTracker';
import {UserGuildSettings} from '@app/api/Tables';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {UserSettingsRepository} from '@app/api/user/repositories/UserSettingsRepository';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {ChannelTypes, Permissions} from '@fluxer/constants/src/ChannelConstants';
import type {ChannelResponse} from '@fluxer/schema/src/domains/channel/ChannelSchemas';
import type {ThreadChannelResponse} from '@fluxer/schema/src/domains/channel/ThreadRequestSchemas';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

interface SearchResult {
	messages: Array<{channel_id: string}>;
	channels: Array<{id: string}>;
	total: number;
}
let harness: ApiTestHarness;
beforeEach(async () => {
	vi.stubEnv('INTEGRATION_GUILD_ID', '');
	harness = await createApiTestHarness({search: 'enabled'});
	clearChannelThreadsTaintCacheForTesting();
});
afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	clearChannelThreadsTaintCacheForTesting();
	await harness.shutdown();
});
async function preference(userId: string, guildId: string, show: boolean) {
	await upsertOne(
		UserGuildSettings.patchByPk(
			{user_id: createUserID(BigInt(userId)), guild_id: createGuildID(BigInt(guildId))},
			{show_nsfw: Db.set(show), nsfw_version: Db.set(1n)},
		),
	);
}
async function setup() {
	const owner = await createTestAccount(harness);
	const guild = await createGuild(harness, owner.token, 'display visibility');
	const sfw = await createChannel(harness, owner.token, guild.id, 'sfw');
	const nsfw = await createChannel(harness, owner.token, guild.id, 'nsfw');
	await updateChannel(harness, owner.token, nsfw.id, {nsfw: true});
	const thread = await threadsRequest<ThreadChannelResponse>(harness, owner.token)
		.post(`/channels/${nsfw.id}/threads`)
		.body({name: 'hidden thread', type: ChannelTypes.PUBLIC_THREAD})
		.expect(201)
		.execute();
	const forum = await threadsRequest<ChannelResponse>(harness, owner.token)
		.post(`/guilds/${guild.id}/channels`)
		.body({name: 'hidden forum', type: ChannelTypes.GUILD_FORUM, nsfw: true})
		.expect(200)
		.execute();
	const message = await sendMessage(harness, owner.token, nsfw.id, 'visibilityneedle hidden');
	await sendMessage(harness, owner.token, sfw.id, 'visibilityneedle safe');
	await threadsRequest(harness, owner.token)
		.post(`/channels/${thread.id}/messages`)
		.body({content: 'visibilityneedle thread'})
		.expect(200)
		.execute();
	await markGuildChannelsAsIndexed(harness, owner.token, guild.id);
	await drainSearchTasks();
	vi.stubEnv('INTEGRATION_GUILD_ID', guild.id);
	return {owner, guild, sfw, nsfw, thread, forum, message};
}

describe('integration guild NSFW HTTP visibility without a gateway session', () => {
	it('defaults to hidden across direct reads, message reads, thread endpoints and both guild lists', async () => {
		const s = await setup();
		const routes = [
			`/channels/${s.nsfw.id}`,
			`/channels/${s.nsfw.id}/messages`,
			`/channels/${s.nsfw.id}/messages/${s.message.id}`,
			`/channels/${s.nsfw.id}/messages/pins`,
			`/channels/${s.thread.id}`,
			`/channels/${s.thread.id}/messages`,
			`/channels/${s.nsfw.id}/threads/archived/public`,
			`/channels/${s.forum.id}/threads/directory`,
			`/channels/${s.forum.id}/threads/search`,
		];
		for (const route of routes) {
			await threadsRequest(harness, s.owner.token).get(route).expect(404, APIErrorCodes.UNKNOWN_CHANNEL).execute();
		}
		await threadsRequest(harness, s.owner.token)
			.post(`/channels/${s.forum.id}/post-data`)
			.body({thread_ids: [s.thread.id]})
			.expect(404, APIErrorCodes.UNKNOWN_CHANNEL)
			.execute();
		await threadsRequest(harness, s.owner.token).get(`/channels/${s.sfw.id}`).expect(200).execute();
		const channels = await threadsRequest<Array<{id: string}>>(harness, s.owner.token)
			.get(`/guilds/${s.guild.id}/channels`)
			.expect(200)
			.execute();
		expect(channels.map((item) => item.id)).toContain(s.sfw.id);
		expect(channels.map((item) => item.id)).not.toContain(s.nsfw.id);
		expect(channels.map((item) => item.id)).not.toContain(s.forum.id);
		const guild = await threadsRequest<{channels: Array<{id: string}>}>(harness, s.owner.token)
			.get(`/guilds/${s.guild.id}`)
			.expect(200)
			.execute();
		expect(guild.channels.map((item) => item.id)).not.toContain(s.nsfw.id);
	});
	it('provides scoped authoritative preference RPC for mutation fencing without a session', async () => {
		const s = await setup();
		const read = async (guildId = s.guild.id) =>
			threadsRequest<{type: string; data: {guild_id: string; show_nsfw: boolean; nsfw_version: number}}>(harness, '')
				.post('/test/rpc-session-init')
				.body({type: 'get_nsfw_display_preference', user_id: s.owner.userId, guild_id: guildId})
				.expect(200)
				.execute();
		expect((await read()).data).toEqual({guild_id: s.guild.id, show_nsfw: false, nsfw_version: 0});
		await preference(s.owner.userId, s.guild.id, true);
		expect((await read()).data).toEqual({guild_id: s.guild.id, show_nsfw: true, nsfw_version: 1});
		const other = await harness.requestJson({
			path: '/test/rpc-session-init',
			method: 'POST',
			body: {type: 'get_nsfw_display_preference', user_id: s.owner.userId, guild_id: '1'},
		});
		expect(other.status).not.toBe(200);
	});
	it('does not expose a target-guild toggle to an unrelated-guild-only session', async () => {
		const s = await setup();
		const outsider = await createTestAccount(harness);
		await createGuild(harness, outsider.token, 'unrelated');
		const response = await threadsRequest<{data: {user_guild_settings: Array<{guild_id: string | null}>}}>(harness, '')
			.post('/test/rpc-session-init')
			.body({type: 'session', token: outsider.token, version: 1, ip: '127.0.0.1'})
			.expect(200)
			.execute();
		expect(response.data.user_guild_settings.some((setting) => setting.guild_id === s.guild.id)).toBe(false);
	});
	it('honors persisted true/false immediately without any gateway session and leaves other guilds alone', async () => {
		const s = await setup();
		await preference(s.owner.userId, s.guild.id, true);
		await threadsRequest(harness, s.owner.token).get(`/channels/${s.thread.id}/messages`).expect(200).execute();
		await preference(s.owner.userId, s.guild.id, false);
		await threadsRequest(harness, s.owner.token)
			.get(`/channels/${s.thread.id}/messages`)
			.expect(404, APIErrorCodes.UNKNOWN_CHANNEL)
			.execute();
		vi.stubEnv('INTEGRATION_GUILD_ID', '999999999999999999');
		await threadsRequest(harness, s.owner.token).get(`/channels/${s.nsfw.id}`).expect(200).execute();
	});
	it('omits hidden explicit channels and inherited threads in every message search scope', async () => {
		const s = await setup();
		for (const scope of ['current', 'all_guilds', 'all', 'open_dms_and_all_guilds']) {
			for (const channelIds of [[s.nsfw.id], [s.thread.id], [s.sfw.id, s.nsfw.id, s.thread.id]]) {
				const response = await threadsRequest<SearchResult>(harness, s.owner.token)
					.post('/search/messages')
					.body({
						scope,
						context_guild_id: s.guild.id,
						content: 'visibilityneedle',
						include_nsfw: true,
						channel_ids: channelIds,
					})
					.expect(200)
					.execute();
				expect(response.messages.map((message) => message.channel_id)).toEqual(
					channelIds.includes(s.sfw.id) ? [s.sfw.id] : [],
				);
				expect(response.total).toBe(channelIds.includes(s.sfw.id) ? 1 : 0);
			}
			const implicit = await threadsRequest<SearchResult>(harness, s.owner.token)
				.post('/search/messages')
				.body({scope, context_guild_id: s.guild.id, content: 'visibilityneedle', include_nsfw: true})
				.expect(200)
				.execute();
			expect(implicit.messages.map((message) => message.channel_id)).toEqual([s.sfw.id]);
		}
	});
	it('rechecks actual thread parents when a directory index still points to an old safe parent', async () => {
		const s = await setup();
		const thread = await threadsRequest<ThreadChannelResponse>(harness, s.owner.token)
			.post(`/channels/${s.sfw.id}/threads`)
			.body({name: 'moving thread', type: ChannelTypes.PUBLIC_THREAD})
			.expect(201)
			.execute();
		await threadsRequest(harness, s.owner.token)
			.post(`/channels/${thread.id}/messages`)
			.body({content: 'movedneedle'})
			.expect(200)
			.execute();
		await drainSearchTasks();
		const repository = new ChannelRepository();
		const stored = await repository.channelData.findUnique(createChannelID(BigInt(thread.id)));
		await repository.channelData.upsert({...stored!.toRow(), parent_id: createChannelID(BigInt(s.nsfw.id))});
		for (const scope of ['current', 'all_guilds', 'all']) {
			const response = await threadsRequest<SearchResult>(harness, s.owner.token)
				.post('/search/messages')
				.body({scope, context_guild_id: s.guild.id, content: 'movedneedle', include_nsfw: true})
				.expect(200)
				.execute();
			expect(response.messages).toEqual([]);
			expect(response.total).toBe(0);
		}
	});
	it('removes hidden legacy and thread read states from a fresh READY/session response', async () => {
		const s = await setup();
		const session = async () =>
			(
				await threadsRequest<{
					data: {read_states: Array<{id: string; last_message_id: string | null; mention_count: number}>};
				}>(harness, '')
					.post('/test/rpc-session-init')
					.body({type: 'session', token: s.owner.token, version: 1, ip: '127.0.0.1', thread_channels_capable: true})
					.expect(200)
					.execute()
			).data;
		const hidden = await session();
		expect(hidden.read_states.map((state) => state.id)).toContain(s.sfw.id);
		expect(hidden.read_states.map((state) => state.id)).not.toContain(s.nsfw.id);
		expect(hidden.read_states.map((state) => state.id)).not.toContain(s.thread.id);
		await preference(s.owner.userId, s.guild.id, true);
		const shown = await session();
		expect(shown.read_states.map((state) => state.id)).toContain(s.nsfw.id);
		expect(shown.read_states.map((state) => state.id)).toContain(s.thread.id);
		await preference(s.owner.userId, s.guild.id, false);
		expect((await session()).read_states.map((state) => state.id)).not.toContain(s.nsfw.id);
	});
	it('does not return hidden read-state details through explicit bulk acknowledgements', async () => {
		const s = await setup();
		const result = await threadsRequest<{read_states: Array<{id: string}>}>(harness, s.owner.token)
			.post('/read-states/ack')
			.body({
				read_states: [
					{channel_id: s.nsfw.id, message_id: s.message.id},
					{channel_id: s.sfw.id, message_id: s.message.id},
				],
			})
			.expect(200)
			.execute();
		expect(result.read_states.map((state) => state.id)).toEqual([s.sfw.id]);
		await preference(s.owner.userId, s.guild.id, true);
		const shown = await threadsRequest<{read_states: Array<{id: string}>}>(harness, s.owner.token)
			.post('/read-states/ack')
			.body({read_states: [{channel_id: s.nsfw.id, message_id: s.message.id}]})
			.expect(200)
			.execute();
		expect(shown.read_states.map((state) => state.id)).toEqual([s.nsfw.id]);
	});
	it('reports dependency failure rather than leaking content or pretending the channel is missing', async () => {
		const s = await setup();
		vi.spyOn(UserSettingsRepository.prototype, 'findGuildSettings').mockRejectedValue(
			new Error('test dependency offline'),
		);
		await threadsRequest(harness, s.owner.token).get(`/channels/${s.nsfw.id}`).expect(503).execute();
		await threadsRequest(harness, s.owner.token).get(`/guilds/${s.guild.id}/channels`).expect(503).execute();
		await threadsRequest(harness, s.owner.token)
			.post('/search/messages')
			.body({context_guild_id: s.guild.id, include_nsfw: true})
			.expect(503)
			.execute();
	});
	it('reports unavailable for failures in new guild and explicit-search classification reads', async () => {
		const s = await setup();
		vi.spyOn(ChannelDataRepository.prototype, 'listChannels').mockRejectedValue(new Error('classification offline'));
		await threadsRequest(harness, s.owner.token).get(`/guilds/${s.guild.id}`).expect(503).execute();
		for (const scope of ['all', 'all_guilds']) {
			await threadsRequest(harness, s.owner.token)
				.post('/search/messages')
				.body({scope, context_guild_id: s.guild.id, channel_ids: [s.nsfw.id], include_nsfw: true})
				.expect(503)
				.execute();
		}
	});
	it('filters active thread lists for bots and cannot bypass hidden thread-member reads', async () => {
		const s = await setup();
		const bot = await createTestBotAccount(harness);
		await threadsRequest(harness, s.owner.token)
			.post('/oauth2/authorize/consent')
			.body({
				client_id: bot.appId,
				scope: 'bot',
				guild_id: s.guild.id,
				permissions: Permissions.ADMINISTRATOR.toString(),
			})
			.execute();
		const token = `Bot ${bot.botToken}`;
		const active = await threadsRequest<{threads: Array<{id: string}>}>(harness, token)
			.get(`/guilds/${s.guild.id}/threads/active`)
			.expect(200)
			.execute();
		expect(active.threads).toEqual([]);
		await threadsRequest(harness, token)
			.get(`/channels/${s.thread.id}/thread-members`)
			.expect(404, APIErrorCodes.UNKNOWN_CHANNEL)
			.execute();
		await preference(bot.botUserId, s.guild.id, true);
		const shown = await threadsRequest<{threads: Array<{id: string}>}>(harness, token)
			.get(`/guilds/${s.guild.id}/threads/active`)
			.expect(200)
			.execute();
		expect(shown.threads.map((thread) => thread.id)).toContain(s.thread.id);
	});
	it('enforces the same preference on visitor reads and visitor guild/channel lists', async () => {
		const s = await setup();
		await getInstanceConfigRepository().updateGuildVisitsConfig({enabled: true, user_basis_points: 10000});
		const visitor = await createTestAccount(harness);
		const invite = await createChannelInvite(harness, s.owner.token, s.sfw.id);
		await threadsRequest(harness, visitor.token).post(`/invites/${invite.code}/visit`).body(null).expect(200).execute();
		await threadsRequest(harness, visitor.token)
			.get(`/channels/${s.nsfw.id}`)
			.expect(404, APIErrorCodes.UNKNOWN_CHANNEL)
			.execute();
		await threadsRequest(harness, visitor.token)
			.get(`/channels/${s.thread.id}/messages`)
			.expect(404, APIErrorCodes.UNKNOWN_CHANNEL)
			.execute();
		const channels = await threadsRequest<Array<{id: string}>>(harness, visitor.token)
			.get(`/guilds/${s.guild.id}/channels`)
			.expect(200)
			.execute();
		expect(channels.map((channel) => channel.id)).toContain(s.sfw.id);
		expect(channels.map((channel) => channel.id)).not.toContain(s.nsfw.id);
		const guild = await threadsRequest<{channels: Array<{id: string}>}>(harness, visitor.token)
			.get(`/guilds/${s.guild.id}`)
			.expect(200)
			.execute();
		expect(guild.channels.map((channel) => channel.id)).not.toContain(s.nsfw.id);
	});
	it('show=true still requires age eligibility and normal member permission', async () => {
		const s = await setup();
		const minor = await createTestAccount(harness, {dateOfBirth: '2012-01-01'});
		const outsider = await createTestAccount(harness);
		const invite = await createChannelInvite(harness, s.owner.token, s.sfw.id);
		await acceptInvite(harness, minor.token, invite.code);
		await preference(minor.userId, s.guild.id, true);
		await preference(outsider.userId, s.guild.id, true);
		await threadsRequest(harness, minor.token)
			.get(`/channels/${s.nsfw.id}/messages`)
			.expect(403, APIErrorCodes.NSFW_CONTENT_AGE_RESTRICTED)
			.execute();
		const denied = await harness.requestJson({
			path: `/channels/${s.nsfw.id}/messages`,
			headers: {authorization: outsider.token},
		});
		expect([403, 404]).toContain(denied.status);
	});
});
