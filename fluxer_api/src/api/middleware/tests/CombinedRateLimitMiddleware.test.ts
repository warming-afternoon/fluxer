// SPDX-License-Identifier: AGPL-3.0-or-later

import {createHash} from 'node:crypto';
import * as AuthSession from '@app/api/auth/AuthSession';
import type {UserID} from '@app/api/BrandedTypes';
import {getConfig} from '@app/api/Config';
import {RateLimitMiddleware, type RouteRateLimitConfig} from '@app/api/middleware/RateLimitMiddleware';
import type {HonoEnv} from '@app/api/types/HonoEnv';
import {UserFlags} from '@fluxer/constants/src/UserConstants';
import {RateLimitError} from '@fluxer/errors/src/domains/core/RateLimitError';
import {Hono} from 'hono';
import {afterEach, describe, expect, it, vi} from 'vitest';

const allowed = {allowed: true, limit: 5, remaining: 4, resetTime: new Date(Date.now() + 10000), resetAfterDecimal: 10};
const denied = {...allowed, allowed: false, remaining: 0, retryAfter: 1, retryAfterDecimal: 0.25};
const route: RouteRateLimitConfig = {bucket: 'ack::channel_id', config: {limit: 5, windowMs: 1000}};
/** 建立带真实中间件语义和可控存储结果的测试入口。 */
function harness(
	options: {config?: RouteRateLimitConfig; principal?: boolean; flags?: bigint; bot?: boolean; enforce?: boolean} = {},
) {
	const service = {
		checkLimit: vi.fn(),
		peekLimit: vi.fn(),
		resetLimit: vi.fn(),
		clearLimitsByIdentifierPrefix: vi.fn(),
		checkGlobalLimit: vi.fn().mockResolvedValue(allowed),
		checkBucketLimit: vi.fn().mockResolvedValue(allowed),
		checkGlobalAndBucketLimit: vi.fn().mockResolvedValue({global: {...allowed, global: true}, bucket: allowed}),
	};
	const errors: Array<Error> = [];
	const app = new Hono<HonoEnv>();
	app.onError((e, c) => {
		errors.push(e);
		return c.text('error', e instanceof RateLimitError ? 429 : 500);
	});
	app.use('*', async (c, next) => {
		c.set('rateLimitService', service);
		if (options.principal) {
			c.set('readStatePrincipal', {
				id: 1n as UserID,
				isBot: options.bot ?? false,
				flags: options.flags ?? 0n,
				deletionStartedAt: null,
				tempBannedUntil: null,
				locale: null,
			});
			c.set('authTokenType', 'session');
			c.set('authToken', 'test-token');
			c.set('apiContext', {} as never);
		}
		await next();
	});
	app.post('/channels/:channel_id', RateLimitMiddleware(options.config ?? route), (c) => c.text('ok'));
	const request = () =>
		app.request('http://localhost/channels/42', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-forwarded-for': '203.0.113.1',
				...(options.enforce === false ? {} : {'x-fluxer-test-enable-rate-limits': 'true'}),
			},
			body: JSON.stringify({email: ' USER@EXAMPLE.COM '}),
		});
	return {service, errors, request};
}
afterEach(() => {
	getConfig().combinedRateLimitEnabled = false;
	vi.restoreAllMocks();
});
describe('combined limiter middleware semantics', () => {
	it('defaults OFF and retains the two existing calls', async () => {
		getConfig().combinedRateLimitEnabled = false;
		const h = harness();
		expect((await h.request()).status).toBe(200);
		expect(h.service.checkGlobalAndBucketLimit).not.toHaveBeenCalled();
		expect(h.service.checkGlobalLimit).toHaveBeenCalledTimes(1);
		expect(h.service.checkBucketLimit).toHaveBeenCalledTimes(1);
	});
	it('uses the same resolved keys and success headers for bot accounts', async () => {
		getConfig().combinedRateLimitEnabled = true;
		const h = harness({principal: true, bot: true});
		const r = await h.request();
		expect(r.status).toBe(200);
		expect(h.service.checkGlobalAndBucketLimit).toHaveBeenCalledWith(
			'user:1:session',
			50,
			'user:1:session:ack:42',
			route.config,
		);
		expect(h.service.checkGlobalLimit).not.toHaveBeenCalled();
		expect(h.service.checkBucketLimit).not.toHaveBeenCalled();
		expect(r.headers.get('X-RateLimit-Limit')).toBe('5');
		expect(r.headers.get('X-RateLimit-Remaining')).toBe('4');
		expect(r.headers.get('X-RateLimit-Reset-After')).toBe('10');
		expect(r.headers.get('X-RateLimit-Bucket')).toBe(
			createHash('sha256').update(route.bucket).digest('hex').slice(0, 16),
		);
	});
	it('revokes a human session on global rejection, without a route or email followup', async () => {
		getConfig().combinedRateLimitEnabled = true;
		const revoke = vi.spyOn(AuthSession, 'revokeToken').mockResolvedValue(undefined);
		const h = harness({principal: true, config: {...route, emailBucket: {bucket: 'email', config: route.config}}});
		h.service.checkGlobalAndBucketLimit.mockResolvedValue({global: denied, bucket: undefined});
		expect((await h.request()).status).toBe(429);
		expect(h.errors[0]).toBeInstanceOf(RateLimitError);
		expect(revoke).toHaveBeenCalledWith({}, 'test-token');
		expect(h.service.checkBucketLimit).not.toHaveBeenCalled();
	});
	it('route rejection does not revoke a session or perform email checks', async () => {
		getConfig().combinedRateLimitEnabled = true;
		const revoke = vi.spyOn(AuthSession, 'revokeToken').mockResolvedValue(undefined);
		const h = harness({principal: true});
		h.service.checkGlobalAndBucketLimit.mockResolvedValue({global: allowed, bucket: denied});
		expect((await h.request()).status).toBe(429);
		expect(revoke).not.toHaveBeenCalled();
		expect(h.service.checkBucketLimit).not.toHaveBeenCalled();
	});
	it('keeps the email bucket as a later independent check', async () => {
		getConfig().combinedRateLimitEnabled = true;
		const h = harness({config: {...route, emailBucket: {bucket: 'email', config: route.config}}});
		expect((await h.request()).status).toBe(200);
		expect(h.service.checkBucketLimit).toHaveBeenCalledWith(
			`email:${createHash('sha256').update('user@example.com').digest('hex').slice(0, 32)}:email`,
			route.config,
		);
	});
	it('global-exempt routes never invoke the combined or global check', async () => {
		getConfig().combinedRateLimitEnabled = true;
		const h = harness({config: {...route, config: {...route.config, exemptFromGlobal: true}}});
		expect((await h.request()).status).toBe(200);
		expect(h.service.checkGlobalAndBucketLimit).not.toHaveBeenCalled();
		expect(h.service.checkGlobalLimit).not.toHaveBeenCalled();
		expect(h.service.checkBucketLimit).toHaveBeenCalledTimes(1);
	});
	it.each([{principal: true, flags: UserFlags.RATE_LIMIT_BYPASS}, {enforce: false}])(
		'retains bypass policy: case %#',
		async (options) => {
			getConfig().combinedRateLimitEnabled = true;
			const h = harness(options);
			expect((await h.request()).status).toBe(200);
			expect(h.service.checkGlobalAndBucketLimit).not.toHaveBeenCalled();
			expect(h.service.checkBucketLimit).not.toHaveBeenCalled();
		},
	);
	it('propagates an unknown result instead of retrying either charge', async () => {
		getConfig().combinedRateLimitEnabled = true;
		const h = harness();
		h.service.checkGlobalAndBucketLimit.mockRejectedValue(new Error('unknown result'));
		expect((await h.request()).status).toBe(500);
		expect(h.service.checkGlobalLimit).not.toHaveBeenCalled();
		expect(h.service.checkBucketLimit).not.toHaveBeenCalled();
	});
});
