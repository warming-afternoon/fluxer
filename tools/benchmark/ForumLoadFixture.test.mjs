// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {compactForumFixture, loadForumLoadFixture} from './ForumLoadFixture.mjs';

/** 检查索引转换后在线读者和目录依旧来自原始夹具。 */
test('compact fixture preserves selected readers, explicit directory and original source', () => {
	const source = {
		accounts: [
			{id: 'u1', joinedThreadIds: ['t1', 'archived']},
			{id: 'u2', joinedThreadIds: ['t1']},
			{id: 'u3', joinedThreadIds: ['t2']},
		],
		threads: [
			{id: 't1', hot: true, memberIds: ['u1', 'u2', 'offline']},
			{id: 't2', memberIds: ['u3']},
			{id: 'archived', archived: true, memberIds: ['u1']},
		],
	};
	const original = structuredClone(source);
	const compact = compactForumFixture(source, 2);
	assert.deepEqual(
		compact.threads.map((thread) => thread.memberIndexes),
		[[0, 1], []],
	);
	assert.deepEqual(
		compact.accounts.map((account) => account.joinedThreadIndexes),
		[[0], [0]],
	);
	assert.deepEqual(source, original);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluxer-compact-test-'));
	try {
		const file = path.join(dir, 'fixture.json');
		fs.writeFileSync(file, JSON.stringify(compact), {mode: 0o600});
		const loaded = loadForumLoadFixture(file, 2);
		assert.deepEqual(
			loaded.accounts.map((account) => account.joinedThreadIds),
			[['t1'], ['t1']],
		);
		compact.threads[0].memberIndexes.push(99);
		fs.writeFileSync(file, JSON.stringify(compact));
		assert.throws(() => loadForumLoadFixture(file, 2), /Invalid member index/);
		compact.threads[0].memberIndexes = [0];
		fs.writeFileSync(file, JSON.stringify(compact));
		assert.throws(() => loadForumLoadFixture(file, 2), /Inconsistent bidirectional/);
	} finally {
		fs.rmSync(dir, {recursive: true});
	}
});
