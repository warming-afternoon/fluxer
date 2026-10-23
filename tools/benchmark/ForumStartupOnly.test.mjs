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

for (const mode of ['complete', 'partial', 'disconnect']) {
	/** 验证启动就绪路径不发送业务负载，并正确报告同步或连接失败。 */
	test(`startup-only preserves readiness and sends no workload: ${mode}`, async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluxer-startup-only-'));
		try {
			const accounts = Array.from({length: 4}, (_, i) => ({
				id: String(100 + i),
				email: `${i}@example.test`,
				password: 'synthetic',
				joinedThreadIds: ['200', '201'],
			}));
			const fixture = path.join(dir, 'fixture.private.json');
			const out = path.join(dir, 'results');
			fs.writeFileSync(
				fixture,
				JSON.stringify(
					compactForumFixture(
						{
							apiBase: 'http://127.0.0.1/api',
							gatewayUrl: 'ws://127.0.0.1/gateway',
							guildId: '300',
							accounts,
							threads: ['200', '201'].map((id) => ({id, hot: true, memberIds: accounts.map((a) => a.id)})),
						},
						4,
					),
				),
				{mode: 0o600},
			);
			let exitCode = 0;
			try {
				await exec(
					process.execPath,
					[
						'--import',
						pathToFileURL(path.join(root, 'mock_forum_transport.mjs')).href,
						path.join(root, 'forum_load.mjs'),
						'--fixture',
						fixture,
						'--out',
						out,
						'--online-steps',
						'4',
						'--startup-only',
						'true',
						'--stable-seconds',
						'0.01',
						'--connect-timeout-ms',
						'150',
					],
					{
						env: {
							...process.env,
							BENCH_TEST_NO_WORKLOAD: '1',
							BENCH_TEST_PARTIAL_SYNC: mode === 'partial' ? '1' : '',
							BENCH_TEST_CLOSE_PARTIAL: mode === 'disconnect' ? '1' : '',
						},
						timeout: 10000,
					},
				);
			} catch (error) {
				if (!fs.existsSync(path.join(out, 'summary.json'))) throw error;
				exitCode = error.code;
			}
			const summary = JSON.parse(fs.readFileSync(path.join(out, 'summary.json')));
			assert.equal(summary.measurementMode, 'startup-preparation-only');
			assert.equal(summary.finalTotals.submitted, 0);
			assert.equal(summary.finalTotals.sendSuccess, 0);
			assert.equal(summary.finalTotals.ackSuccess, 0);
			assert.equal(fs.readFileSync(path.join(out, 'messages.jsonl'), 'utf8'), '');
			if (mode === 'complete') {
				assert.equal(exitCode, 0);
				assert.equal(summary.completed, true);
				assert.equal(summary.allRequestedTiersPassed, true);
				assert.equal(summary.actualOnlineBeforeExit, 4);
				assert.equal(summary.tiers[0].capacityPassed, null);
				assert.deepEqual(summary.stages, []);
			} else {
				assert.equal(exitCode, 2);
				assert.equal(summary.completed, false);
				assert.ok(summary.abortReason);
			}
		} finally {
			fs.rmSync(dir, {recursive: true, force: true});
		}
	});
}
