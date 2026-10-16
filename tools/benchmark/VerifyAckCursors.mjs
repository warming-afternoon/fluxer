// SPDX-License-Identifier: AGPL-3.0-or-later

import {createHash} from 'node:crypto';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const require = createRequire(new URL('../../fluxer_api/package.json', import.meta.url));
const {Client, types} = require('cassandra-driver');

/** 在受保护的本地测试库只读核验全部最终游标，不把行内容写入摘要。 */
async function main() {
	if (process.env.FLUXER_BENCHMARK_RESET_DISPOSABLE !== 'yes') throw Error('Disposable benchmark guard required');
	const [input, output] = process.argv.slice(2);
	if (!input || !output || fs.statSync(input).size > 8 * 1024 * 1024) throw Error('Expected bounded cursor manifest');
	const raw = fs.readFileSync(input);
	const entries = JSON.parse(raw);
	if (!Array.isArray(entries) || entries.length > 200000) throw Error('Cursor manifest exceeds bounds');
	const users = new Map();
	for (const entry of entries) {
		for (const value of [entry.userId, entry.channelId, entry.messageId])
			if (!/^\d{1,20}$/.test(value)) throw Error('Invalid cursor identifier');
		if (!users.has(entry.userId)) users.set(entry.userId, []);
		users.get(entry.userId).push(entry);
	}
	const client = new Client({
		contactPoints: ['127.0.0.1'],
		localDataCenter: 'datacenter1',
		keyspace: 'fluxer_benchmark',
		protocolOptions: {port: 29042},
	});
	let checked = 0,
		missing = 0,
		behind = 0,
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
							{prepare: true, fetchSize: 1000, pageState},
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
					}
				}
			}),
		);
	} finally {
		await client.shutdown();
	}
	const proof = {
		ok: missing === 0 && behind === 0 && checked === entries.length,
		users: users.size,
		checked,
		missing,
		behind,
		manifestSha256: createHash('sha256').update(raw).digest('hex'),
		readOnly: true,
	};
	fs.writeFileSync(output, JSON.stringify(proof, null, 2));
	console.log(JSON.stringify(proof));
	if (!proof.ok) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
