// SPDX-License-Identifier: AGPL-3.0-or-later

import * as AuthSession from '@app/api/auth/AuthSession';
import {getRequestIdentity, isReadStatePrincipalRequest} from '@app/api/auth/ReadStatePrincipal';
import {createUserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {setCassandraQueryExecutorForTesting} from '@app/api/database/CassandraQueryExecution';
import {EMPTY_USER_ROW, type UserRow} from '@app/api/database/types/UserTypes';
import {DefaultUserOnly, LoginRequired} from '@app/api/middleware/AuthMiddleware';
import {LocaleMiddleware} from '@app/api/middleware/LocaleMiddleware';
import {UserMiddleware} from '@app/api/middleware/UserMiddleware';
import type {AuthSession as Session} from '@app/api/models/AuthSession';
import {User} from '@app/api/models/User';
import {Users} from '@app/api/Tables';
import {InMemoryCassandraQueryExecutor} from '@app/api/test/InMemoryCassandraQueryExecutor';
import type {HonoEnv} from '@app/api/types/HonoEnv';
import {UserFlags} from '@fluxer/constants/src/UserConstants';
import {Hono} from 'hono';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const id = createUserID(123n);
const token = `flx_${'a'.repeat(36)}`;
let previous = false;
let row: UserRow;
let executor: InMemoryCassandraQueryExecutor;

beforeEach(async () => {
	previous = Config.readState!.narrowAuthEnabled;
	Config.readState!.narrowAuthEnabled = true;
	row = {...EMPTY_USER_ROW, user_id: id, username: 'synthetic', bot: false, flags: 0n, locale: 'zh-CN'};
	executor = new InMemoryCassandraQueryExecutor();
	setCassandraQueryExecutorForTesting(executor);
	await executor.executeQuery(Users.upsertAll(row));
	vi.spyOn(AuthSession, 'getAuthSessionByToken').mockResolvedValue({
		userId: id,
		sessionIdHash: Buffer.alloc(32),
	} as Session);
	vi.spyOn(AuthSession, 'updateAuthSessionLastUsed').mockResolvedValue(undefined);
	vi.spyOn(AuthSession, 'revokeToken').mockResolvedValue(undefined);
});
afterEach(() => {
	Config.readState!.narrowAuthEnabled = previous;
	vi.restoreAllMocks();
	setCassandraQueryExecutorForTesting(null);
});

/** 使用真实认证中间件与数据库执行器，只替换会话令牌查询和活动写入。 */
function app() {
	const findUnique = vi.fn(async () => new User(row));
	const activity = vi.fn();
	const api = new Hono<HonoEnv>();
	api.use(async (ctx, next) => {
		ctx.set('apiContext', {services: {users: {findUnique}}} as unknown as HonoEnv['Variables']['apiContext']);
		ctx.set('userActivityBuffer', {recordActivity: activity} as unknown as HonoEnv['Variables']['userActivityBuffer']);
		ctx.set('kvActivityTracker', {
			updateActivity: async () => {},
		} as unknown as HonoEnv['Variables']['kvActivityTracker']);
		await next();
	});
	api.use(UserMiddleware, LocaleMiddleware);
	api.onError((error, ctx) => ctx.json({error: error.name}, error.name === 'AccessDeniedError' ? 403 : 401));
	api.post('/channels/:channel/messages/:message/ack', LoginRequired, DefaultUserOnly, (ctx) =>
		ctx.json({
			id: getRequestIdentity(ctx)!.id.toString(),
			full: !!ctx.get('user'),
			narrow: !!ctx.get('readStatePrincipal'),
			locale: ctx.get('requestLocale'),
		}),
	);
	api.get('/users/@me', LoginRequired, (ctx) =>
		ctx.json({full: !!ctx.get('user'), narrow: !!ctx.get('readStatePrincipal')}),
	);
	return {api, findUnique, activity};
}

it('limits narrow authentication to exact POST ACK routes', () => {
	for (const path of ['/channels/1/messages/2/ack', '/v1/read-states/ack', '/api/read-states/ack-bulk'])
		expect(isReadStatePrincipalRequest('POST', path)).toBe(true);
	for (const path of ['/channels/1/messages/2/ack/extra', '/users/@me', '/channels/1/pins/ack'])
		expect(isReadStatePrincipalRequest('POST', path)).toBe(false);
	expect(isReadStatePrincipalRequest('DELETE', '/channels/1/messages/2/ack')).toBe(false);
});

it('reads only six columns and preserves activity and locale without creating a partial User', async () => {
	const query = vi.spyOn(executor, 'executeQuery');
	const {api, findUnique, activity} = app();
	const response = await api.request('/channels/1/messages/2/ack', {method: 'POST', headers: {Authorization: token}});
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({id: '123', full: false, narrow: true, locale: 'zh-CN'});
	expect(findUnique).not.toHaveBeenCalled();
	expect(query.mock.calls[0]![0].kvMeta!.columns).toEqual([
		'user_id',
		'bot',
		'flags',
		'deletion_started_at',
		'temp_banned_until',
		'locale',
	]);
	expect(activity).toHaveBeenCalledTimes(1);
	expect(AuthSession.updateAuthSessionLastUsed).toHaveBeenCalledTimes(1);
});

it('keeps other routes and the disabled optimization on the full User path', async () => {
	const {api, findUnique} = app();
	expect(await (await api.request('/users/@me', {headers: {Authorization: token}})).json()).toEqual({
		full: true,
		narrow: false,
	});
	Config.readState!.narrowAuthEnabled = false;
	expect(
		(await api.request('/channels/1/messages/2/ack', {method: 'POST', headers: {Authorization: token}})).status,
	).toBe(200);
	expect(findUnique).toHaveBeenCalledTimes(2);
});

describe('fresh account status', () => {
	it.each(['deleted', 'deleting', 'banned', 'missing', 'bot'] as const)('still rejects %s accounts', async (kind) => {
		if (kind === 'deleted') row.flags = UserFlags.DELETED;
		if (kind === 'deleting') row.deletion_started_at = new Date();
		if (kind === 'banned') {
			row.flags = UserFlags.DISABLED;
			row.temp_banned_until = new Date(Date.now() + 60_000);
		}
		if (kind === 'bot') row.bot = true;
		if (kind === 'missing') await executor.executeQuery(Users.deleteByPk({user_id: id}));
		else await executor.executeQuery(Users.upsertAll(row));
		const {api, findUnique} = app();
		const response = await api.request('/channels/1/messages/2/ack', {method: 'POST', headers: {Authorization: token}});
		expect(response.status).toBeGreaterThanOrEqual(400);
		expect(findUnique).not.toHaveBeenCalled();
	});

	it('does not authenticate a revoked or missing session', async () => {
		vi.mocked(AuthSession.getAuthSessionByToken).mockResolvedValue(null);
		const query = vi.spyOn(executor, 'executeQuery');
		const {api} = app();
		expect(
			(await api.request('/channels/1/messages/2/ack', {method: 'POST', headers: {Authorization: token}})).status,
		).toBe(401);
		expect(query).not.toHaveBeenCalled();
	});
});
