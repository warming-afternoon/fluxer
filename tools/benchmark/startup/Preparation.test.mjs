import test from 'node:test';

import assert from 'node:assert/strict';
import {verifyIsolation, prepareBenchmark} from './Preparation.mjs';
const identity = {
	name: 'owned',
	id: '1',
	imageId: 'sha256:a',
	project: 'isolated',
	memoryBytes: 1,
	cpuSet: '',
	portsSha256: 'p',
	mountsSha256: 'm',
};
test('one batch inspect validates all immutable identity and budget fields', async () => {
	let calls = 0;
	await verifyIsolation({
		expected: [identity],
		inspect: async (names) => {
			calls++;
			assert.deepEqual(names, ['owned']);
			return [{...identity, running: true}];
		},
	});
	assert.equal(calls, 1);
	await assert.rejects(
		verifyIsolation({expected: [identity], inspect: async () => [{...identity, id: 'stale', running: true}]}),
		/mismatch/,
	);
});
test('keeper closes after target directory and before stability; full audit is separate', async () => {
	const events = [];
	/** 创建记录阶段调用顺序的异步测试适配器。 */
	const hook = (name) => async () => {
		events.push(name);
		return true;
	};
	const run = await prepareBenchmark({
		verifyInputs: hook('inputs'),
		verifyContainers: hook('isolation'),
		prepareRouting: hook('routing'),
		openKeeper: hook('keeper'),
		verifyMembership: hook('membership'),
		connectTarget: hook('target'),
		waitFirstDirectory: hook('directory'),
		closeKeeper: hook('close'),
		waitStable: hook('stable'),
		auditMembers: hook('audit'),
		waitPushDrain: hook('drain'),
	});
	assert.deepEqual(events, [
		'inputs',
		'isolation',
		'routing',
		'keeper',
		'membership',
		'target',
		'directory',
		'close',
		'stable',
	]);
	await run.auditAfterMeasurement();
	assert.deepEqual(events.slice(-2), ['audit', 'drain']);
});
test('keeper closure failure never releases target into stable measurement', async () => {
	let stable = false;
	await assert.rejects(
		prepareBenchmark({
			verifyInputs: async () => {},
			verifyContainers: async () => {},
			prepareRouting: async () => {},
			openKeeper: async () => ({}),
			verifyMembership: async () => {},
			connectTarget: async () => ({close: async () => {}}),
			waitFirstDirectory: async () => {},
			closeKeeper: async () => false,
			waitStable: async () => {
				stable = true;
			},
		}),
		/did not close/,
	);
	assert.equal(stable, false);
});

import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileSha256, verifyRestoredFixture} from './Preparation.mjs';
test('fixture proof binds immutable restore identity and refuses changed input', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'fluxer-proof-'));
	const path = join(dir, 'fixture.json');
	try {
		await writeFile(path, '{}');
		const options = {
			snapshot: {treeSha256: 's'},
			restoration: {snapshotTreeSha256: 's', complete: true, independentInodes: true},
			fixturePath: path,
			proof: {snapshotTreeSha256: 's', membersVerified: true, fixtureSha256: await fileSha256(path)},
		};
		await verifyRestoredFixture(options);
		await writeFile(path, '[]');
		await assert.rejects(verifyRestoredFixture(options), /mismatch/);
	} finally {
		await rm(dir, {recursive: true, force: true});
	}
});
