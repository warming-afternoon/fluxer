// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import test from 'node:test';
import {FrontendAckQueue} from './FrontendAckQueue.mjs';

/** 用可控时钟证明首条期限、覆盖、失败与并发到达规则。 */
test('frontend ACK semantics and coverage', async () => {
	let now = 0,
		pending = 0,
		active = 0;
	const calls = [],
		covered = [],
		errors = [];
	let status = 200;
	const q = new FrontendAckQueue({
		now: () => now,
		queued: (n) => (pending += n),
		active: (n) => (active += n),
		covered: (_, job) => covered.push(job.messageId),
		failed: (e) => errors.push(e),
		send: async (_, entries) => {
			calls.push(entries);
			return {status, data: {read_states: entries.map((e) => ({id: e.channel_id, last_message_id: e.message_id}))}};
		},
	});
	const user = {account: {id: '1'}};
	try {
		q.enqueue(user, {messageId: '10', m: {thread: {id: '2'}}});
		now = 2000;
		q.enqueue(user, {messageId: '11', m: {thread: {id: '2'}}});
		now = 2999;
		q.pump();
		assert.equal(calls.length, 0);
		now = 3000;
		q.pump();
		await new Promise(setImmediate);
		assert.deepEqual(calls[0], [{channel_id: '2', message_id: '11'}]);
		assert.deepEqual(covered, ['10', '11']);
		assert.equal(pending, 0);
		assert.equal(active, 0);
		status = 503;
		q.enqueue(user, {messageId: '12', m: {thread: {id: '2'}}}, {hadMentions: true});
		await new Promise(setImmediate);
		assert.equal(calls.length, 2);
		assert.equal(pending, 1);
		now = 7999;
		q.pump();
		assert.equal(calls.length, 2);
		status = 200;
		now = 8000;
		q.pump();
		await new Promise(setImmediate);
		assert.equal(pending, 0);
		assert.equal(q.stats.httpFailures, 1);
		assert.equal(errors.length, 0);
	} finally {
		q.close();
	}
});

/** 验证批量上限、在途新消息保留及不完整权威响应拒绝。 */
test('batch limit and invalid cursor fail closed', async () => {
	let now = 0;
	const calls = [];
	const errors = [];
	const q = new FrontendAckQueue({
		now: () => now,
		queued: () => {},
		active: () => {},
		covered: () => {},
		failed: (e) => errors.push(e),
		send: async (_, entries) => {
			calls.push(entries);
			return {status: 200, data: {read_states: []}};
		},
	});
	try {
		for (let i = 0; i < 101; i++) q.enqueue({account: {id: '1'}}, {messageId: '10', m: {thread: {id: String(i)}}});
		now = 3000;
		q.pump();
		q.close();
		await new Promise(setImmediate);
		assert.equal(calls[0].length, 100);
		assert.equal(errors.length, 1);
		assert.equal(q.stats.coveredMessages, 0);
	} finally {
		q.close();
	}
});

/** 在途较新消息不会被旧响应清除，较旧到达不回退最大游标。 */
test('in-flight arrivals remain queued and cursors never regress', async () => {
	let now = 0,
		pending = 0,
		resolveFirst;
	const calls = [],
		covered = [],
		errors = [];
	const q = new FrontendAckQueue({
		now: () => now,
		queued: (n) => (pending += n),
		active: () => {},
		covered: (_, job) => covered.push(job.messageId),
		failed: (e) => errors.push(e),
		send: async (_, entries) => {
			calls.push(entries);
			if (calls.length === 1) await new Promise((resolve) => (resolveFirst = resolve));
			return {
				status: 200,
				data: {read_states: entries.map((e) => ({id: e.channel_id, last_message_id: e.message_id}))},
			};
		},
	});
	const user = {account: {id: '1'}};
	try {
		q.enqueue(user, {messageId: '10', m: {thread: {id: '2'}}});
		now = 3000;
		q.pump();
		q.enqueue(user, {messageId: '12', m: {thread: {id: '2'}}});
		q.enqueue(user, {messageId: '11', m: {thread: {id: '2'}}});
		resolveFirst();
		await new Promise(setImmediate);
		await new Promise(setImmediate);
		assert.deepEqual(
			calls.map((x) => x[0].message_id),
			['10', '12'],
		);
		assert.deepEqual(covered, ['10', '12', '11']);
		assert.equal(pending, 0);
		assert.equal(q.cursors.get('1:2').messageId, '12');
		assert.equal(errors.length, 0);
	} finally {
		q.close();
	}
});

/** 八个槽持续饱和时，一百个到期用户均先获得一轮机会再重复首批用户。 */
test('one hundred saturated users all receive a slot before repeat service', async () => {
	let now = 0,
		pending = 0;
	const calls = [],
		errors = [];
	const q = new FrontendAckQueue({
		concurrency: 8,
		now: () => now,
		queued: (n) => (pending += n),
		active: () => {},
		covered: () => {},
		failed: (e) => errors.push(e),
		send: async (user, entries) => {
			calls.push(user.account.id);
			return {
				status: 200,
				data: {read_states: entries.map((e) => ({id: e.channel_id, last_message_id: e.message_id}))},
			};
		},
	});
	try {
		const users = Array.from({length: 100}, (_, i) => ({account: {id: String(i)}}));
		for (const user of users) q.enqueue(user, {messageId: '10', m: {thread: {id: '9'}}});
		now = 3000;
		q.pump();
		for (const user of users) q.enqueue(user, {messageId: '11', m: {thread: {id: '9'}}});
		await new Promise(setImmediate);
		assert.equal(new Set(calls.slice(0, 100)).size, 100);
		assert.equal(calls.length, 108);
		assert.equal(pending, 0);
		assert.equal(errors.length, 0);
	} finally {
		q.close();
	}
});
