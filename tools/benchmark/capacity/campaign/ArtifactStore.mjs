// SPDX-License-Identifier: AGPL-3.0-or-later

import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';

const LIMIT = 16 * 1024 * 1024;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
/** New attempt only; large evidence is byte-sharded without losing fields. No secrets should be passed here. */
export async function createArtifactStore(config) {
	await mkdir(path.dirname(config.paths.outRoot), {recursive: true, mode: 0o700});
	await mkdir(config.paths.outRoot, {mode: 0o700});
	const root = config.paths.privateRoot;
	await mkdir(root, {mode: 0o700});
	const manifest = [];
	async function write(name, value) {
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw Error('Unsafe artifact name');
		const bytes = Buffer.from(
			`${JSON.stringify(value, function (key, v) {
				const raw = this[key];
				if (raw instanceof Map) return {$capacityType: 'Map', entries: [...raw]};
				if (raw instanceof Uint8Array) return {$capacityType: 'Bytes', base64: Buffer.from(raw).toString('base64')};
				return typeof v === 'bigint' ? String(v) : v;
			})}\n`,
		);
		const parts = [];
		for (let offset = 0, index = 0; offset < bytes.length; offset += LIMIT, index++) {
			const part = bytes.subarray(offset, offset + LIMIT),
				file = `${name}.${index}.json-part`;
			await writeFile(path.join(root, file), part, {flag: 'wx', mode: 0o600});
			parts.push({file, bytes: part.length, sha256: hash(part)});
		}
		const ref = {name, encoding: 'utf8-json-concatenated', bytes: bytes.length, sha256: hash(bytes), parts};
		manifest.push(ref);
		return ref;
	}
	async function finish() {
		return write('MANIFEST', {
			schema: 'benchmark.capacity-artifacts.v1',
			runId: config.runId,
			attemptId: config.attemptId,
			scenarioSha256: config.scenarioSha256,
			artifacts: [...manifest],
		});
	}
	return {write, finish, manifest, root};
}
/** Verify every part and the reconstructed document before parsing. */
export async function readArtifact(root, ref) {
	const buffers = [];
	for (const part of ref.parts) {
		if (path.basename(part.file) !== part.file) throw Error('Unsafe artifact reference');
		const bytes = await readFile(path.join(root, part.file));
		if (bytes.length !== part.bytes || hash(bytes) !== part.sha256) throw Error('Artifact part integrity failure');
		buffers.push(bytes);
	}
	const bytes = Buffer.concat(buffers);
	if (bytes.length !== ref.bytes || hash(bytes) !== ref.sha256) throw Error('Artifact integrity failure');
	return JSON.parse(bytes.toString('utf8'), (_key, v) =>
		v?.$capacityType === 'Map'
			? new Map(v.entries)
			: v?.$capacityType === 'Bytes'
				? Buffer.from(v.base64, 'base64')
				: v,
	);
}
