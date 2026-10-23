// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {promisify} from 'node:util';
import {compactForumFixture} from './ForumLoadFixture.mjs';

const exec = promisify(execFile);
const root = path.dirname(fileURLToPath(import.meta.url));

/** 离线模拟传输验证递增上线、逐人确认及失败检测，不作为性能结果。 */
for (const mode of ['success', 'duplicate', 'ackFailure', 'missing']) {
	/** 验证离线负载模拟仍检查唯一投递、ACK 与遗漏消息。 */
	test(`compact load tool preserves correctness checks: ${mode}`, async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluxer-load-tool-'));
		try {
			const accounts = Array.from({length: 4}, (_, index) => ({
				id: String(100 + index),
				email: `${index}@example.test`,
				password: 'synthetic',
				joinedThreadIds: ['200'],
			}));
			const source = {
				apiBase: 'http://127.0.0.1/api',
				gatewayUrl: 'ws://127.0.0.1/gateway',
				guildId: '300',
				accounts,
				threads: [{id: '200', hot: true, memberIds: accounts.map((account) => account.id)}],
			};
			const fixture = path.join(dir, 'fixture.private.json'),
				plan = path.join(dir, 'plan.json'),
				out = path.join(dir, 'result');
			fs.writeFileSync(fixture, JSON.stringify(compactForumFixture(source, 4)), {mode: 0o600});
			fs.writeFileSync(plan, JSON.stringify([{name: 'burst', burst: 10, concurrency: 2}]));
			await exec(
				process.execPath,
				[
					'--max-old-space-size=128',
					'--expose-gc',
					'--import',
					pathToFileURL(path.join(root, 'mock_forum_transport.mjs')).href,
					path.join(root, 'forum_load.mjs'),
					'--fixture',
					fixture,
					'--out',
					out,
					'--online-steps',
					'2,4',
					'--plan',
					plan,
					'--stable-seconds',
					'0',
					'--recovery-seconds',
					'0',
					'--drain-seconds',
					'1',
				],
				{
					env: {
						...process.env,
						BENCH_TEST_DUPLICATE: mode === 'duplicate' ? '1' : '',
						BENCH_TEST_ACK_FAILURE: mode === 'ackFailure' ? '1' : '',
						BENCH_TEST_MISSING: mode === 'missing' ? '1' : '',
					},
					timeout: 15000,
				},
			);
			const summary = JSON.parse(fs.readFileSync(path.join(out, 'summary.json')));
			assert.equal(summary.passed, mode === 'success');
			if (mode === 'success') {
				assert.equal(summary.totals.connectionsReady, 4);
				assert.equal(summary.totals.sendSuccess, 20);
				assert.equal(summary.totals.actualUniqueDeliveries, 60);
				assert.equal(summary.totals.ackSuccess, 60);
				assert.equal(summary.highestPassedOnline, 4);
				const messages = fs.readFileSync(path.join(out, 'messages.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
				assert.ok(messages.every((message) => message.actualRecipientIds.every((id) => typeof id === 'string')));
			} else if (mode === 'duplicate') {
				assert.ok(summary.totals.duplicates > 0);
			} else if (mode === 'missing') {
				assert.ok(summary.totals.missingDeliveries > 0);
			} else {
				assert.ok(summary.totals.ackFailed > 0);
				assert.ok(summary.totals.missingAcks > 0);
			}
		} finally {
			fs.rmSync(dir, {recursive: true});
		}
	});
}

/** 只有显式选择后才跨过吞吐不达标的档位，错误或漏消息仍会停止。 */
test('capacity continuation stays opt-in and never labels a slow tier as capacity passed', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluxer-load-capacity-'));
	try {
		const source = {
			apiBase: 'http://127.0.0.1/api',
			gatewayUrl: 'ws://127.0.0.1/gateway',
			guildId: '300',
			accounts: Array.from({length: 4}, (_, i) => ({
				id: String(100 + i),
				email: `${i}@example.test`,
				password: 'synthetic',
				joinedThreadIds: ['200'],
			})),
			threads: [{id: '200', hot: true, memberIds: ['100', '101', '102', '103']}],
		};
		const fixture = path.join(dir, 'fixture.private.json'),
			plan = path.join(dir, 'plan.json');
		fs.writeFileSync(fixture, JSON.stringify(compactForumFixture(source, 4)), {mode: 0o600});
		fs.writeFileSync(plan, JSON.stringify([{name: 'fixed', rate: 10, seconds: 0.2}]));
		for (const enabled of [false, true]) {
			const out = path.join(dir, String(enabled));
			await exec(
				process.execPath,
				[
					'--max-old-space-size=128',
					'--import',
					pathToFileURL(path.join(root, 'mock_forum_transport.mjs')).href,
					path.join(root, 'forum_load.mjs'),
					'--fixture',
					fixture,
					'--out',
					out,
					'--online-steps',
					'2,4',
					'--plan',
					plan,
					'--stable-seconds',
					'0',
					'--recovery-seconds',
					'0',
					'--drain-seconds',
					'3',
					'--ack-concurrency',
					'1',
					'--continue-after-capacity-failure',
					String(enabled),
				],
				{env: {...process.env, BENCH_TEST_ACK_DELAY_MS: '100'}, timeout: 15000},
			);
			const result = JSON.parse(fs.readFileSync(path.join(out, 'summary.json')));
			assert.equal(result.tiers.length, enabled ? 2 : 1);
			assert.ok(result.tiers.every((tier) => tier.passed && !tier.capacityPassed));
			assert.equal(result.highestCapacityPassedOnline, 0);
		}
	} finally {
		fs.rmSync(dir, {recursive: true});
	}
});
