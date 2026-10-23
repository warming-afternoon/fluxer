// SPDX-License-Identifier: AGPL-3.0-or-later

import {createChannelID, createGuildID} from '@app/api/BrandedTypes';
import {setCassandraQueryExecutorForTesting} from '@app/api/database/CassandraQueryExecution';
import {GuildAvailabilityMiddleware} from '@app/api/middleware/GuildAvailabilityMiddleware';
import type {Channel} from '@app/api/models/Channel';
import type {Guild} from '@app/api/models/Guild';
import type {User} from '@app/api/models/User';
import type {HonoEnv} from '@app/api/types/HonoEnv';
import {GuildFeatures} from '@fluxer/constants/src/GuildConstants';
import {Hono} from 'hono';
import {afterEach, expect, it, vi} from 'vitest';

afterEach(() => {
	setCassandraQueryExecutorForTesting(null);
});

it.each([true, false])(
	'still checks current guild availability and never inserts partial channel objects, shared=%s',
	async (shared) => {
		const channelId = createChannelID(1n);
		const guildId = createGuildID(2n);
		const features = new Set<string>();
		const findUnique = vi.fn(async () => ({id: channelId, guildId}) as Channel);
		const metadata = vi.fn(async () => new Map([[channelId, {channelId, guildId, type: 11}]]));
		setCassandraQueryExecutorForTesting({
			executeQuery: async () => [],
			executeBatch: async () => {},
			...(shared ? {getChannelMetadata: metadata} : {}),
		});
		const getGuildSystem = vi.fn(async () => ({features}) as Guild);
		const channels = new Map();
		const app = new Hono<HonoEnv>();
		app.use(async (ctx, next) => {
			ctx.set('user', {flags: 0n} as User);
			ctx.set('channelRepository', {channelData: {findUnique}} as unknown as HonoEnv['Variables']['channelRepository']);
			ctx.set('guildService', {
				data: {operations: {getGuildSystem}},
			} as unknown as HonoEnv['Variables']['guildService']);
			ctx.set('requestCache', {channels, guilds: new Map()} as unknown as HonoEnv['Variables']['requestCache']);
			await next();
		});
		app.use(GuildAvailabilityMiddleware);
		app.get('/channels/:id', (ctx) => ctx.text('ok'));
		app.onError((_error, ctx) => ctx.text('denied', 403));
		expect((await app.request('/channels/1')).status).toBe(200);
		expect(channels.size).toBe(shared ? 0 : 1);
		features.add(GuildFeatures.UNAVAILABLE_FOR_EVERYONE);
		expect((await app.request('/channels/1')).status).toBe(403);
		expect(getGuildSystem).toHaveBeenCalledTimes(2);
		expect(findUnique).toHaveBeenCalledTimes(shared ? 0 : 2);
		expect(metadata).toHaveBeenCalledTimes(shared ? 2 : 0);
	},
);
