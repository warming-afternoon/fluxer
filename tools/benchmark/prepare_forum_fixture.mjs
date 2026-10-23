// SPDX-License-Identifier: AGPL-3.0-or-later

import fs from 'node:fs';
import path from 'node:path';
import {compactForumFixture} from './ForumLoadFixture.mjs';

const options = Object.fromEntries(
	process.argv
		.slice(2)
		.filter((_, index) => index % 2 === 0)
		.map((key, index) => [key, process.argv.slice(2)[index * 2 + 1]]),
);
if (!options['--source'] || !options['--out'] || !options['--max-online']) {
	throw new Error('Usage: prepare_forum_fixture.mjs --source PRIVATE_FILE --out NEW_PRIVATE_FILE --max-online COUNT');
}
if (path.resolve(options['--source']) === path.resolve(options['--out']))
	throw new Error('Do not overwrite the original fixture');
const fixture = compactForumFixture(
	JSON.parse(fs.readFileSync(options['--source'], 'utf8')),
	Number(options['--max-online']),
);
fs.mkdirSync(path.dirname(options['--out']), {recursive: true, mode: 0o700});
fs.writeFileSync(options['--out'], JSON.stringify(fixture), {mode: 0o600, flag: 'wx'});
// 输出只包含规模和大小，不输出账号、密码、令牌和设备信息。
console.log(
	JSON.stringify({
		accounts: fixture.accounts.length,
		activeThreads: fixture.threads.length,
		membershipPositions: fixture.threads.reduce((sum, thread) => sum + thread.memberIndexes.length, 0),
		bytes: fs.statSync(options['--out']).size,
	}),
);
