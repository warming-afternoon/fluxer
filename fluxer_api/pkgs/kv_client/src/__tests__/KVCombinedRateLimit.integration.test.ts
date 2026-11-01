// SPDX-License-Identifier: AGPL-3.0-or-later
import {readFileSync} from 'node:fs';
import {KVClient} from '@pkgs/kv_client/src/KVClient';
import Redis from 'ioredis';
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from 'vitest';

const url = process.env.FLUXER_C_TEST_VALKEY_URL;
const baselinePath = process.env.FLUXER_C_BASELINE_KV_SOURCE;
function originalLua(): string {
	if (!baselinePath) throw new Error('Baseline source path is required for original-Lua gate');
	const source = readFileSync(baselinePath, 'utf8');
	const decode = source.match(/const DECODE_BUCKET_STATE_SCRIPT = `([\s\S]*?)`;/)?.[1];
	const script = source.match(/const CHECK_LEAKY_BUCKET_LIMIT_SCRIPT = `([\s\S]*?)`;/)?.[1];
	if (!decode || !script) throw new Error('Missing original Lua constants');
	return script.replace(
		/\$\{DECODE_BUCKET_STATE_SCRIPT\}/,
		decode.replace(/\$\{MAX_DATE_TIMESTAMP\}/, '8640000000000000'),
	);
}

describe.skipIf(!url)('real standalone combined limiter', () => {
	let client: KVClient;
	let admin: Redis;
	const now = 1800000000000;
	const args = ['c:global', 5, 1000, 'c:route', 2, 2000] as const;
	beforeAll(() => {
		client = new KVClient(url!);
		admin = new Redis(url!);
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		await admin.flushdb();
	});
	afterAll(async () => {
		client.close();
		await admin.quit();
	});
	it('matches old two-command state/results including fractional leakage, deny and clock rollback', async () => {
		for (const t of [now, now, now + 125, now + 126, now + 126, now - 20, now + 1000, now + 5000]) {
			vi.spyOn(Date, 'now').mockReturnValue(t);
			const global = await client.checkLeakyBucketLimit('old:g', 5, 1000, 1);
			const bucket = global.allowed ? await client.checkLeakyBucketLimit('old:b', 2, 2000, 1) : undefined;
			const combined = await client.checkGlobalAndBucketLimit(...args);
			expect(combined).toEqual({global, ...(bucket && {bucket})});
			expect(await admin.get('c:global')).toBe(await admin.get('old:g'));
			expect(await admin.get('c:route')).toBe(await admin.get('old:b'));
			vi.restoreAllMocks();
		}
	});

	it.skipIf(!baselinePath)(
		'matches reference original Lua for both costs and sequential combined decisions',
		async () => {
			const script = originalLua();
			for (const t of [now, now, now + 125, now + 126, now + 126, now - 20, now + 1000, now + 5000]) {
				vi.spyOn(Date, 'now').mockReturnValue(t);
				const global = JSON.parse(String(await admin.eval(script, 1, 'original:g', t, 5, 1000, 1)));
				const bucket = global.allowed
					? JSON.parse(String(await admin.eval(script, 1, 'original:b', t, 2, 2000, 1)))
					: undefined;
				expect(await client.checkGlobalAndBucketLimit(...args)).toEqual({global, ...(bucket && {bucket})});
				expect(await admin.get('c:global')).toBe(await admin.get('original:g'));
				expect(await admin.get('c:route')).toBe(await admin.get('original:b'));
				vi.restoreAllMocks();
			}
			for (const cost of [1, 1, 0, 1, 0]) {
				vi.spyOn(Date, 'now').mockReturnValue(now);
				const expected = JSON.parse(String(await admin.eval(script, 1, 'original:single', now, 2, 1000, cost)));
				expect(await client.checkLeakyBucketLimit('new:single', 2, 1000, cost)).toEqual(expected);
				vi.restoreAllMocks();
			}
		},
	);
	it('does not charge again when the actual applied result becomes unknown', async () => {
		vi.spyOn(Date, 'now').mockReturnValue(now);
		await client.checkGlobalAndBucketLimit('warm:g', 5, 1000, 'warm:b', 5, 1000);
		const raw = Reflect.get(client, 'client') as Redis;
		const original = Reflect.get(raw, 'evalsha');
		const evalSpy = vi.spyOn(raw, 'eval');
		let calls = 0;
		Reflect.set(raw, 'evalsha', async (...args: Array<unknown>) => {
			calls++;
			await Reflect.apply(original, raw, args);
			throw new Error('timeout: applied result unknown');
		});
		try {
			await expect(client.checkGlobalAndBucketLimit('lost:g', 5, 1000, 'lost:b', 5, 1000)).rejects.toThrow('timed out');
			expect(calls).toBe(1);
			expect(evalSpy).not.toHaveBeenCalled();
			expect(JSON.parse((await admin.get('lost:g'))!).level).toBe(1);
			expect(JSON.parse((await admin.get('lost:b'))!).level).toBe(1);
		} finally {
			Reflect.set(raw, 'evalsha', original);
		}
	});
	it('preserves atomic concurrent accounting and leaves route untouched on global reject', async () => {
		vi.spyOn(Date, 'now').mockReturnValue(now);
		const results = await Promise.all(
			Array.from({length: 50}, () => client.checkGlobalAndBucketLimit('c:global', 5, 1000, 'c:route', 2, 2000)),
		);
		expect(results.filter((x) => x.global.allowed)).toHaveLength(5);
		expect(results.filter((x) => x.bucket?.allowed)).toHaveLength(2);
		expect(results.filter((x) => !x.global.allowed).every((x) => x.bucket === undefined)).toBe(true);
		expect(JSON.parse((await admin.get('c:global'))!)).toEqual({level: 5, updatedAt: now});
		expect(JSON.parse((await admin.get('c:route'))!)).toEqual({level: 2, updatedAt: now});
		const before = await admin.get('c:route');
		await client.checkGlobalAndBucketLimit(...args);
		expect(await admin.get('c:route')).toBe(before);
	});
	it('preserves TTL and does not refresh a denied-global route', async () => {
		vi.spyOn(Date, 'now').mockReturnValue(now);
		await client.checkGlobalAndBucketLimit('c:global', 1, 1000, 'c:route', 2, 2000);
		const ttl = await admin.pttl('c:route');
		expect(ttl).toBeGreaterThan(800);
		expect(ttl).toBeLessThanOrEqual(1000);
		await admin.pexpire('c:route', 500);
		await client.checkGlobalAndBucketLimit('c:global', 1, 1000, 'c:route', 2, 2000);
		expect(await admin.pttl('c:route')).toBeLessThanOrEqual(500);
		const absent = await client.checkGlobalAndBucketLimit('c:global', 1, 1000, 'c:new', 2, 2000);
		expect(absent.bucket).toBeUndefined();
		expect(await admin.exists('c:new')).toBe(0);
	});
	it('recovers from actual SCRIPT FLUSH without duplicate charging', async () => {
		vi.spyOn(Date, 'now').mockReturnValue(now);
		await client.checkGlobalAndBucketLimit(...args);
		await admin.script('FLUSH');
		await client.checkGlobalAndBucketLimit(...args);
		expect(JSON.parse((await admin.get('c:global'))!).level).toBe(2);
		expect(JSON.parse((await admin.get('c:route'))!).level).toBe(2);
	});
});
