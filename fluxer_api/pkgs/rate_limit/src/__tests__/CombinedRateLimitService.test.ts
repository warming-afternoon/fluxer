// SPDX-License-Identifier: AGPL-3.0-or-later
import {RateLimitService} from '@pkgs/rate_limit/src/RateLimitService';
import {describe, expect, it, vi} from 'vitest';

const allowed = {allowed: true, limit: 5, remaining: 4, resetAfterMs: 250, resetAtMs: 1250, retryAfterMs: 0};
const denied = {...allowed, allowed: false, remaining: 0, retryAfterMs: 250};
function store() {
	return {checkLeakyBucketLimit: vi.fn(), del: vi.fn(), scan: vi.fn()};
}
describe('combined rate-limit service', () => {
	it('retains key names and global/header time conversion', async () => {
		const s = {...store(), checkGlobalAndBucketLimit: vi.fn().mockResolvedValue({global: allowed, bucket: denied})};
		const result = await new RateLimitService(s).checkGlobalAndBucketLimit('user:1', 5, 'user:1:ack', {
			limit: 5,
			windowMs: 2000,
		});
		expect(s.checkGlobalAndBucketLimit).toHaveBeenCalledWith(
			'ratelimit:global:user:1',
			5,
			1000,
			'ratelimit:bucket:user:1:ack',
			5,
			2000,
		);
		expect(result.global).toMatchObject({global: true, resetTime: new Date(1250), resetAfterDecimal: 0.25});
		expect(result.bucket).toMatchObject({retryAfter: 1, retryAfterDecimal: 0.25});
		expect(s.checkLeakyBucketLimit).not.toHaveBeenCalled();
	});
	it('supports legacy providers without charging route on global rejection', async () => {
		const s = store();
		s.checkLeakyBucketLimit.mockResolvedValue(denied);
		expect(
			(await new RateLimitService(s).checkGlobalAndBucketLimit('u', 5, 'b', {limit: 5, windowMs: 1000})).bucket,
		).toBeUndefined();
		expect(s.checkLeakyBucketLimit).toHaveBeenCalledTimes(1);
	});
	it('does not retry separate calls after a combined result is unknown', async () => {
		const s = {...store(), checkGlobalAndBucketLimit: vi.fn().mockRejectedValue(new Error('unknown'))};
		await expect(
			new RateLimitService(s).checkGlobalAndBucketLimit('u', 5, 'b', {limit: 5, windowMs: 1000}),
		).rejects.toThrow('unknown');
		expect(s.checkLeakyBucketLimit).not.toHaveBeenCalled();
	});
});
