// SPDX-License-Identifier: AGPL-3.0-or-later
import {KVClient} from '@pkgs/kv_client/src/KVClient';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const {evalsha, evalScript} = vi.hoisted(() => ({evalsha: vi.fn(), evalScript: vi.fn()}));
vi.mock('ioredis', () => {
	class Redis {
		evalsha = evalsha;
		eval = evalScript;
	}
	return {default: Redis, Cluster: Redis};
});
const allowed = {allowed: true, limit: 5, remaining: 4, resetAfterMs: 200, resetAtMs: 1000, retryAfterMs: 0};
const denied = {...allowed, allowed: false, remaining: 0, retryAfterMs: 200};
const call = (c: KVClient) => c.checkGlobalAndBucketLimit('global', 5, 1000, 'route', 5, 1000);
describe('combined KV execution safety', () => {
	beforeEach(() => {
		evalsha.mockReset();
		evalScript.mockReset();
	});
	it('uses one two-key EVALSHA and strictly parses both results', async () => {
		evalsha.mockResolvedValue(JSON.stringify({global: allowed, bucket: allowed}));
		expect(await call(new KVClient('redis://localhost:6379'))).toEqual({global: allowed, bucket: allowed});
		expect(evalsha).toHaveBeenCalledTimes(1);
		expect(evalsha.mock.calls[0]?.slice(1, 4)).toEqual([2, 'global', 'route']);
		expect(evalScript).not.toHaveBeenCalled();
	});
	it('only retries NOSCRIPT as EVAL with identical arguments', async () => {
		evalsha.mockRejectedValue(new Error('NOSCRIPT No matching script'));
		evalScript.mockResolvedValue(JSON.stringify({global: denied}));
		expect(await call(new KVClient('redis://localhost:6379'))).toEqual({global: denied});
		expect(evalScript.mock.calls[0]?.slice(1)).toEqual(evalsha.mock.calls[0]?.slice(1));
	});
	it.each(['timeout result unknown', 'connection closed', 'ERR invalid stored bucket'])(
		'never retries an unknown/error outcome: %s',
		async (error) => {
			evalsha.mockRejectedValue(new Error(error));
			await expect(call(new KVClient('redis://localhost:6379'))).rejects.toThrow();
			expect(evalsha).toHaveBeenCalledTimes(1);
			expect(evalScript).not.toHaveBeenCalled();
		},
	);
	it('does not reinterpret a malformed reply as a reason to double-charge', async () => {
		evalsha.mockResolvedValue(JSON.stringify({global: allowed}));
		await expect(call(new KVClient('redis://localhost:6379'))).rejects.toThrow();
		expect(evalsha).toHaveBeenCalledTimes(1);
		expect(evalScript).not.toHaveBeenCalled();
	});
	it('keeps Cluster on sequential single-key commands and skips route on global rejection', async () => {
		const client = new KVClient('redis://localhost:6379');
		vi.spyOn(client, 'isClustered').mockReturnValue(true);
		evalsha.mockResolvedValueOnce(JSON.stringify(allowed)).mockResolvedValueOnce(JSON.stringify(denied));
		expect(await call(client)).toEqual({global: allowed, bucket: denied});
		expect(evalsha.mock.calls.map((c) => c[1])).toEqual([1, 1]);
		evalsha.mockReset().mockResolvedValue(JSON.stringify(denied));
		expect(await call(client)).toEqual({global: denied});
		expect(evalsha).toHaveBeenCalledTimes(1);
	});
});
