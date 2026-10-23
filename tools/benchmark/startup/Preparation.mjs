// SPDX-License-Identifier: AGPL-3.0-or-later
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';

/** 读取文件并返回 SHA-256 十六进制摘要。 */
export async function fileSha256(path) {
	return createHash('sha256')
		.update(await readFile(path))
		.digest('hex');
}

// A restored immutable fixture may reuse its member proof. Never reuse a live DB proof.
/** 校验恢复快照、独立 inode 和 fixture 内容仍与成员证明一致。 */
export async function verifyRestoredFixture({snapshot, restoration, fixturePath, proof}) {
	// 快照恢复证明只允许复用不可变 fixture 的成员校验结果。
	if (
		!snapshot.treeSha256 ||
		restoration.snapshotTreeSha256 !== snapshot.treeSha256 ||
		restoration.complete !== true ||
		restoration.independentInodes !== true ||
		proof.snapshotTreeSha256 !== snapshot.treeSha256 ||
		proof.membersVerified !== true ||
		proof.fixtureSha256 !== (await fileSha256(fixturePath))
	)
		throw Error('Restored fixture proof mismatch');
	return {snapshotTreeSha256: snapshot.treeSha256, fixtureSha256: proof.fixtureSha256, membersVerified: true};
}

// One inspect operation for all owned containers, with a fresh identity check each run.
/** 一次性检查本轮拥有的容器身份、资源预算及运行状态。 */
export async function verifyIsolation({expected, inspect}) {
	if (!Array.isArray(expected) || !expected.length) throw Error('Expected owned containers required');
	// 对完整目标集合做一次检查，避免部分检查掩盖身份遗漏。
	const rows = await inspect(expected.map((x) => x.name));
	if (!Array.isArray(rows) || rows.length !== expected.length) throw Error('Incomplete isolation inspection');
	const byName = new Map(rows.map((row) => [row.name, row]));
	if (byName.size !== rows.length) throw Error('Duplicate isolation identity');
	for (const want of expected) {
		const actual = byName.get(want.name);
		// 每轮都核对静态身份和资源边界，且只接受正在运行的目标。
		for (const key of ['id', 'imageId', 'project', 'memoryBytes', 'cpuSet', 'portsSha256', 'mountsSha256']) {
			if (want[key] === undefined || actual?.[key] !== want[key])
				throw Error(`Isolation mismatch: ${want.name}/${key}`);
		}
		if (actual.running !== true) throw Error(`Owned container not running: ${want.name}`);
	}
	return rows;
}

// Preparation A/B/C is adapter driven: no fixture IP rewriting, bypass, CAS migration or load.
// The keeper preserves functional warmup, then hands ownership to the connected target.
/** 按适配器顺序准备基准目标，并在测量后审计成员与 Push 排空。 */
export async function prepareBenchmark({
	verifyInputs,
	verifyContainers,
	prepareRouting,
	openKeeper,
	verifyMembership,
	connectTarget,
	waitFirstDirectory,
	closeKeeper,
	waitStable,
	auditMembers,
	waitPushDrain,
}) {
	const stages = [];
	let keeper = null,
		target = null,
		keeperClosed = false;
	/** 运行一个准备步骤并保留其单调时钟区间。 */
	const stage = async (name, fn) => {
		// 记录每个阶段的单调时钟边界，便于复核准备顺序。
		const startNs = process.hrtime.bigint();
		const value = await fn();
		stages.push({
			// 固定阶段名供准备报告按顺序识别。
			name,

			// 起止值均为单调时钟纳秒字符串。
			startNs: String(startNs),
			finishNs: String(process.hrtime.bigint()),
		});
		return value;
	};
	try {
		// 先验证输入与环境，再准备路由及 keeper，最后交接给目标连接。
		await stage('inputs', verifyInputs);
		await stage('isolation', verifyContainers);
		await stage('routing', prepareRouting);
		keeper = await stage('keeper', openKeeper);
		await stage('membership-precheck', () => verifyMembership(keeper));
		target = await stage('target-connect', connectTarget);
		await stage('target-first-directory', () => waitFirstDirectory(target));
		await stage('keeper-close', async () => {
			if ((await closeKeeper(keeper)) !== true) throw Error('Keeper did not close');
			keeperClosed = true;
		});
		await stage('target-stable', () => waitStable(target));
		return {
			target,
			stages,
			/** 在测量结束后执行成员审计和 Push 排空。 */
			async auditAfterMeasurement() {
				await stage('full-member-audit', () => auditMembers(target));
				await stage('push-drain', waitPushDrain);
				return {ok: true, stages};
			},
		};
	} catch (error) {
		if (keeper && !keeperClosed) {
			try {
				await closeKeeper(keeper);
			} catch {}
		}
		if (target?.close) {
			try {
				await target.close();
			} catch {}
		}
		error.preparationStages = stages;
		throw error;
	}
}
