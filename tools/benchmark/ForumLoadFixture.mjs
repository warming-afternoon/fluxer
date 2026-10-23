// SPDX-License-Identifier: AGPL-3.0-or-later

import fs from 'node:fs';

export const COMPACT_FIXTURE_FORMAT = 'fluxer-forum-load-v1';

/** 只保留目标用户和活跃帖子，成员关系用整数下标表示，服务端数据不变。 */
export function compactForumFixture(source, maxOnline) {
	if (!Number.isSafeInteger(maxOnline) || maxOnline < 2 || source.accounts.length < maxOnline) {
		throw new Error('Fixture does not contain the requested number of accounts');
	}
	const selected = source.accounts.slice(0, maxOnline);
	const users = new Map(selected.map((account, index) => [String(account.id), index]));
	if (users.size !== maxOnline) throw new Error('Fixture contains duplicate account IDs');
	const active = source.threads.filter((thread) => thread.active !== false && !thread.archived);
	const threadIndexes = new Map(active.map((thread, index) => [String(thread.id), index]));
	if (threadIndexes.size !== active.length) throw new Error('Fixture contains duplicate active thread IDs');
	const threads = active.map((thread) => ({
		id: String(thread.id),
		hot: thread.hot === true,
		memberIndexes: [
			...new Set(thread.memberIds.map((id) => users.get(String(id))).filter((index) => index !== undefined)),
		],
	}));
	const accounts = selected.map((account) => {
		if (!Array.isArray(account.joinedThreadIds)) throw new Error('Fixture needs explicit joined thread IDs');
		return {
			id: String(account.id),
			...(account.email ? {email: account.email} : {}),
			...(account.login ? {login: account.login} : {}),
			...(account.password ? {password: account.password} : {}),
			...(account.token ? {token: account.token} : {}),
			joinedThreadIndexes: [
				...new Set(
					account.joinedThreadIds.map((id) => threadIndexes.get(String(id))).filter((index) => index !== undefined),
				),
			],
		};
	});
	return {
		format: COMPACT_FIXTURE_FORMAT,
		apiBase: source.apiBase,
		gatewayUrl: source.gatewayUrl,
		guildId: source.guildId,
		metadata: source.metadata,
		accounts,
		threads,
	};
}

/** 加载精简私有夹具并共享 ID 字符串，检测越界关系和双向成员关系不一致。 */
export function loadForumLoadFixture(file, maxOnline) {
	const source = JSON.parse(fs.readFileSync(file, 'utf8'));
	if (source.format !== COMPACT_FIXTURE_FORMAT)
		throw new Error('Prepare a compact private fixture before running this tool');
	if (!Number.isSafeInteger(maxOnline) || maxOnline < 2 || source.accounts.length < maxOnline) {
		throw new Error('Compact fixture does not contain the requested number of accounts');
	}
	const threads = source.threads.map((thread) => {
		if (
			!Array.isArray(thread.memberIndexes) ||
			thread.memberIndexes.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= source.accounts.length)
		) {
			throw new Error('Invalid member index in compact fixture');
		}
		return {
			id: String(thread.id),
			hot: thread.hot === true,
			memberIndexes: thread.memberIndexes.filter((index) => index < maxOnline),
		};
	});
	const joined = Array.from({length: maxOnline}, () => new Set());
	for (let index = 0; index < threads.length; index++) {
		for (const member of threads[index].memberIndexes) joined[member].add(index);
	}
	const accounts = source.accounts.slice(0, maxOnline).map((account, index) => {
		if (
			!Array.isArray(account.joinedThreadIndexes) ||
			account.joinedThreadIndexes.some(
				(thread) => !Number.isSafeInteger(thread) || thread < 0 || thread >= threads.length,
			)
		) {
			throw new Error('Invalid joined thread index in compact fixture');
		}
		const expected = new Set(account.joinedThreadIndexes);
		if (expected.size !== joined[index].size || [...expected].some((thread) => !joined[index].has(thread))) {
			throw new Error('Inconsistent bidirectional membership in compact fixture');
		}
		const {joinedThreadIndexes, ...credentials} = account;
		return {...credentials, index, joinedThreadIds: joinedThreadIndexes.map((thread) => threads[thread].id)};
	});
	if (new Set(accounts.map((account) => account.id)).size !== maxOnline)
		throw new Error('Duplicate account IDs in compact fixture');
	return {
		apiBase: source.apiBase,
		gatewayUrl: source.gatewayUrl,
		guildId: source.guildId,
		metadata: source.metadata,
		accounts,
		threads,
	};
}
