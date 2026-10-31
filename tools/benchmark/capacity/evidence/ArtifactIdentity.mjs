// SPDX-License-Identifier: AGPL-3.0-or-later

import path from 'node:path';

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const IDENTITY_FIELDS = ['runId', 'attemptId', 'stageId', 'scenarioSha256', 'artifactKind', 'visibility'];

/** 用一个显式合同区分运行、阶段、预览/终稿与私有/输出工件。 */
export function validateArtifactIdentity(identity) {
	if (!identity || typeof identity !== 'object') throw new TypeError('Artifact identity required');
	for (const key of ['runId', 'attemptId', 'stageId']) {
		if (typeof identity[key] !== 'string' || !SEGMENT.test(identity[key])) {
			throw new Error('Invalid artifact identity: ' + key);
		}
	}
	if (!/^[a-f0-9]{64}$/.test(identity.scenarioSha256 ?? '')) throw new Error('Scenario SHA256 required');
	if (!['preview', 'final'].includes(identity.artifactKind)) throw new Error('Explicit preview/final kind required');
	if (!['private', 'out'].includes(identity.visibility)) throw new Error('Explicit private/out visibility required');
	return Object.fromEntries(IDENTITY_FIELDS.map((key) => [key, identity[key]]));
}

/** 校验副本身份的所有维度，不能将预览或另一输出域当作最终证据。 */
export function assertArtifactIdentity(actual, expected) {
	const normalized = validateArtifactIdentity(actual);
	const wanted = validateArtifactIdentity(expected);
	for (const key of IDENTITY_FIELDS) {
		if (normalized[key] !== wanted[key]) throw new Error('Artifact identity mismatch: ' + key);
	}
	return normalized;
}

/** 仅派生分离目录，不创建文件、不启动进程或改变权限。 */
export function deriveArtifactDirectory(root, identity) {
	const value = validateArtifactIdentity(identity);
	if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('Absolute artifact root required');
	return path.join(root, value.runId, value.attemptId, value.stageId, value.visibility, value.artifactKind);
}
