// SPDX-License-Identifier: AGPL-3.0-or-later

import {createHash} from 'node:crypto';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

function findApiPackage() {
	let directory = path.dirname(fileURLToPath(import.meta.url));
	while (true) {
		const candidate = path.join(directory, 'fluxer_api', 'package.json');
		if (fs.existsSync(candidate)) return candidate;
		const parent = path.dirname(directory);
		if (parent === directory) throw Error('Cannot locate fluxer_api/package.json above this script');
		directory = parent;
	}
}

const require = createRequire(findApiPackage());
const {Client, auth, types} = require('cassandra-driver');
const MAX_SIGNED_64 = 9223372036854775807n;

function isBusinessId(value) {
	if (typeof value !== 'string' || !/^\d{1,19}$/.test(value)) return false;
	const parsed = BigInt(value);
	return parsed > 0n && parsed <= MAX_SIGNED_64;
}

function cassandraConfig() {
	const contactPoints = (process.env.FLUXER_CASSANDRA_HOSTS || '127.0.0.1')
		.split(',')
		.map((host) => host.trim())
		.filter(Boolean);
	if (!contactPoints.length) throw Error('FLUXER_CASSANDRA_HOSTS must contain at least one host');
	const isLoopback = (host) => {
		const normalized = host.toLowerCase().replace(/^\[|\]$/g, '');
		return normalized === 'localhost' || normalized === '::1' || /^127(?:\.\d{1,3}){3}$/.test(normalized);
	};
	if (contactPoints.some((host) => !isLoopback(host)) && process.env.FLUXER_BENCHMARK_ALLOW_REMOTE !== 'yes') {
		throw Error('Non-loopback Cassandra requires FLUXER_BENCHMARK_ALLOW_REMOTE=yes');
	}
	const port = Number(process.env.FLUXER_CASSANDRA_PORT || 29042);
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid FLUXER_CASSANDRA_PORT');
	const username = process.env.FLUXER_CASSANDRA_USERNAME;
	const password = process.env.FLUXER_CASSANDRA_PASSWORD;
	if ((username === undefined) !== (password === undefined)) {
		throw Error('Set both FLUXER_CASSANDRA_USERNAME and FLUXER_CASSANDRA_PASSWORD, or neither');
	}
	return {
		contactPoints,
		localDataCenter: process.env.FLUXER_CASSANDRA_LOCAL_DC || 'datacenter1',
		keyspace: process.env.FLUXER_CASSANDRA_KEYSPACE || 'fluxer_benchmark',
		protocolOptions: {port},
		...(username !== undefined ? {authProvider: new auth.PlainTextAuthProvider(username, password)} : {}),
	};
}

/** 在受保护的本地测试库只读核验 manifest 游标；证明文件不包含凭据或业务 ID。 */
async function main() {
	if (process.env.FLUXER_BENCHMARK_RESET_DISPOSABLE !== 'yes') {
		throw Error('Disposable benchmark guard required');
	}
	const [input, output] = process.argv.slice(2);
	if (!input || !output || fs.statSync(input).size > 8 * 1024 * 1024) {
		throw Error('Expected bounded cursor manifest and proof output path');
	}
	const raw = fs.readFileSync(input);
	const entries = JSON.parse(raw);
	if (!Array.isArray(entries) || entries.length > 200000) throw Error('Cursor manifest exceeds bounds');
	if (entries.length === 0) throw Error('Cursor manifest is empty');
	const users = new Map();
	for (const entry of entries) {
		for (const value of [entry?.userId, entry?.channelId, entry?.messageId]) {
			if (!isBusinessId(value)) throw Error('Invalid signed-64 business cursor ID');
		}
		if (!users.has(entry.userId)) users.set(entry.userId, []);
		users.get(entry.userId).push(entry);
	}
	const client = new Client(cassandraConfig());
	let checked = 0,
		missing = 0,
		behind = 0,
		ahead = 0,
		index = 0;
	const grouped = [...users.entries()];
	try {
		await client.connect();
		await Promise.all(
			Array.from({length: Math.min(8, grouped.length)}, async () => {
				while (index < grouped.length) {
					const [userId, expected] = grouped[index++];
					const rows = new Map();
					let pageState;
					do {
						const result = await client.execute(
							'SELECT channel_id, message_id FROM read_states WHERE user_id = ?',
							[types.Long.fromString(userId)],
							{prepare: true, fetchSize: 1000, pageState, consistency: types.consistencies.localQuorum},
						);
						for (const row of result.rows) rows.set(row.channel_id.toString(), row.message_id?.toString());
						pageState = result.pageState;
						if (rows.size > 200000) throw Error('Read-state partition exceeds verification bound');
					} while (pageState);
					for (const entry of expected) {
						checked++;
						const actual = rows.get(entry.channelId);
						if (!actual) missing++;
						else if (BigInt(actual) < BigInt(entry.messageId)) behind++;
						else if (BigInt(actual) > BigInt(entry.messageId)) ahead++;
					}
				}
			}),
		);
	} finally {
		await client.shutdown();
	}
	const proof = {
		ok: missing === 0 && behind === 0 && ahead === 0 && checked === entries.length,
		users: users.size,
		checked,
		missing,
		behind,
		ahead,
		manifestSha256: createHash('sha256').update(raw).digest('hex'),
		readOnly: true,
	};
	fs.writeFileSync(output, `${JSON.stringify(proof, null, 2)}\n`, {flag: 'wx', mode: 0o600});
	console.log(JSON.stringify(proof));
	if (!proof.ok) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
