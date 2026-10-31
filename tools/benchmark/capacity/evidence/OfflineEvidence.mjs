// SPDX-License-Identifier: AGPL-3.0-or-later

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {assertArtifactIdentity, validateArtifactIdentity} from './ArtifactIdentity.mjs';

/** 只解析归档内部普通文件，拒绝绝对路径、上跳和符号链接。 */
function ownedFile(root, relative, mustExist = true) {
	if (
		typeof relative !== 'string' ||
		relative.length === 0 ||
		relative.includes('\\') ||
		path.posix.isAbsolute(relative) ||
		relative.split('/').some((part) => !part || part === '.' || part === '..')
	)
		throw Error('Evidence reference must be a normalized relative file path');
	const resolvedRoot = fs.realpathSync(root);
	const candidate = path.resolve(resolvedRoot, ...relative.split('/'));
	if (!candidate.startsWith(resolvedRoot + path.sep)) throw Error('Evidence reference escaped root');
	let current = resolvedRoot;
	for (const part of relative.split('/')) {
		current = path.join(current, part);
		if (!fs.existsSync(current)) {
			if (mustExist) throw Error('Missing evidence reference: ' + relative);
			break;
		}
		if (fs.lstatSync(current).isSymbolicLink()) throw Error('Evidence symlink refused: ' + relative);
	}
	if (mustExist && !fs.statSync(candidate).isFile()) throw Error('Evidence reference is not a regular file');
	return candidate;
}

/** 为完整字节流计算摘要，不依赖文件名推断业务身份。 */
export async function hashEvidenceFile(filename) {
	const digest = crypto.createHash('sha256');
	let bytes = 0;
	for await (const chunk of fs.createReadStream(filename)) {
		digest.update(chunk);
		bytes += chunk.length;
	}
	return {sha256: digest.digest('hex'), bytes};
}

/** 用显式文件清单建立不可覆盖副本，失败残留由独立结果证明标记。 */
export async function createEvidenceBundle({sourceRoot, destinationRoot, files, identity, requiredPaths}) {
	if (!Array.isArray(files) || files.length === 0 || new Set(files).size !== files.length)
		throw Error('Unique explicit evidence file list required');
	identity = validateArtifactIdentity(identity);
	if (
		!Array.isArray(requiredPaths) ||
		requiredPaths.length === 0 ||
		requiredPaths.some((item) => !files.includes(item))
	)
		throw Error('Required offline inputs must all be explicitly included');
	const source = fs.realpathSync(sourceRoot);
	const parent = fs.realpathSync(path.dirname(path.resolve(destinationRoot)));
	const destination = path.join(parent, path.basename(destinationRoot));
	if (destination === source || destination.startsWith(source + path.sep) || source.startsWith(destination + path.sep))
		throw Error('Evidence roots must be separate');
	if (fs.existsSync(destination)) throw Error('Evidence bundle destination already exists; use a new attempt');
	fs.mkdirSync(destination, {mode: 0o700});
	const proof = {
		schema: 'benchmark.evidence-bundle.v1',
		identity,
		createdUtc: new Date().toISOString(),
		sourceRoot: source,
		requiredPaths,
		files: [],
		complete: false,
	};
	try {
		for (const relative of files) {
			if (['BUNDLE-PROOF.json', 'BUNDLE-FAILURE.json'].includes(relative))
				throw Error('Reserved evidence proof filename');
			const original = ownedFile(source, relative);
			const before = await hashEvidenceFile(original);
			const copy = ownedFile(destination, relative, false);
			fs.mkdirSync(path.dirname(copy), {recursive: true, mode: 0o700});
			fs.copyFileSync(original, copy, fs.constants.COPYFILE_EXCL);
			const [after, copied] = await Promise.all([hashEvidenceFile(original), hashEvidenceFile(copy)]);
			if (
				before.sha256 !== after.sha256 ||
				before.sha256 !== copied.sha256 ||
				before.bytes !== after.bytes ||
				before.bytes !== copied.bytes
			)
				throw Error('Source changed or copied evidence mismatched: ' + relative);
			proof.files.push({path: relative, ...copied});
		}
		proof.complete = true;
		fs.writeFileSync(path.join(destination, 'BUNDLE-PROOF.json'), JSON.stringify(proof, null, 2) + '\n', {
			flag: 'wx',
			mode: 0o600,
		});
		return proof;
	} catch (error) {
		fs.writeFileSync(
			path.join(destination, 'BUNDLE-FAILURE.json'),
			JSON.stringify({...proof, error: String(error.message), failedUtc: new Date().toISOString()}, null, 2) + '\n',
			{flag: 'wx', mode: 0o600},
		);
		throw error;
	}
}

/** 完全离线校验副本，原路径只作来源说明，不再读取原服务或目录。 */
export async function verifyEvidenceBundle(bundleRoot, expectedIdentity) {
	const root = fs.realpathSync(bundleRoot);
	const proof = JSON.parse(fs.readFileSync(ownedFile(root, 'BUNDLE-PROOF.json'), 'utf8'));
	if (
		proof.schema !== 'benchmark.evidence-bundle.v1' ||
		proof.complete !== true ||
		!Array.isArray(proof.files) ||
		!Array.isArray(proof.requiredPaths)
	)
		throw Error('Complete supported bundle proof required');
	assertArtifactIdentity(proof.identity, expectedIdentity);
	const paths = new Set();
	for (const file of proof.files) {
		if (paths.has(file.path)) throw Error('Duplicate bundle file proof');
		paths.add(file.path);
		const actual = await hashEvidenceFile(ownedFile(root, file.path));
		if (actual.sha256 !== file.sha256 || actual.bytes !== file.bytes)
			throw Error('Bundle evidence hash mismatch: ' + file.path);
	}
	if (proof.requiredPaths.length === 0 || proof.requiredPaths.some((relative) => !paths.has(relative)))
		throw Error('Bundle lacks required offline inputs');
	return proof;
}

/** 派生输出单独命名且不可覆盖，保留所有原始失败和既有判定。 */
export function writeDerivedJson(destination, value) {
	const parent = fs.realpathSync(path.dirname(path.resolve(destination)));
	const output = path.join(parent, path.basename(destination));
	if (fs.existsSync(output)) throw Error('Derived output exists; choose a new revision');
	fs.writeFileSync(output, JSON.stringify(value, null, 2) + '\n', {flag: 'wx', mode: 0o600});
	return {path: output, sha256: crypto.createHash('sha256').update(fs.readFileSync(output)).digest('hex')};
}
