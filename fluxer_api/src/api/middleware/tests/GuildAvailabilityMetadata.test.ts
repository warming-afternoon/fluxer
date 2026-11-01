// SPDX-License-Identifier: AGPL-3.0-or-later

import {createChannelID, createGuildID} from '@app/api/BrandedTypes';
import {setCassandraQueryExecutorForTesting} from '@app/api/database/CassandraQueryExecution';
import {GuildAvailabilityMiddleware} from '@app/api/middleware/GuildAvailabilityMiddleware';
import type {Channel} from '@app/api/models/Channel';
import type {Guild} from '@app/api/models/Guild';
import type {User} from '@app/api/models/User';
import type {HonoEnv} from '@app/api/types/HonoEnv';
import {GuildFeatures} from '@fluxer/constants/src/GuildConstants';
import {UserFlags} from '@fluxer/constants/src/UserConstants';
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

it.each([
	[false, false, false, 200],
	[true, false, false, 403],
	[true, false, true, 403],
	[false, true, false, 403],
	[false, true, true, 200],
	[true, true, true, 403],
])('checks the minimal snapshot: everyone=%s nonStaff=%s staff=%s', async (everyone, nonStaff, staff, status) => {
	const guildId = createGuildID(2n);
	const guilds = new Map();
	const getGuildSystem = vi.fn();
	const app = new Hono<HonoEnv>();
	setCassandraQueryExecutorForTesting({
		executeQuery: async () => [],
		executeBatch: async () => {},
		getGuildAvailability: async () => ({
			guildId,
			unavailableForEveryone: everyone as boolean,
			unavailableForNonStaff: nonStaff as boolean,
		}),
	});
	app.use(async (ctx, next) => {
		ctx.set('user', {flags: staff ? UserFlags.STAFF : 0n} as User);
		ctx.set('guildService', {data: {operations: {getGuildSystem}}} as unknown as HonoEnv['Variables']['guildService']);
		ctx.set('requestCache', {guilds} as unknown as HonoEnv['Variables']['requestCache']);
		await next();
	});
	app.use(GuildAvailabilityMiddleware);
	app.get('/guilds/:id', (ctx) => ctx.text('ok'));
	app.onError((_error, ctx) => ctx.text('denied', 403));
	expect((await app.request('/guilds/2')).status).toBe(status);
	expect(guilds.size).toBe(0);
	expect(getGuildSystem).not.toHaveBeenCalled();
});

it.each([null, new Error('database down')])(
	'preserves missing guild pass-through and query errors: %s',
	async (result) => {
		setCassandraQueryExecutorForTesting({
			executeQuery: async () => [],
			executeBatch: async () => {},
			getGuildAvailability: async () => {
				if (result instanceof Error) throw result;
				return null;
			},
		});
		const app = new Hono<HonoEnv>();
		app.use(async (ctx, next) => {
			ctx.set('user', {flags: 0n} as User);
			await next();
		});
		app.use(GuildAvailabilityMiddleware);
		app.get('/guilds/:id', (ctx) => ctx.text('ok'));
		app.onError((_error, ctx) => ctx.text('failed', 500));
		expect((await app.request('/guilds/2')).status).toBe(result ? 500 : 200);
	},
);
