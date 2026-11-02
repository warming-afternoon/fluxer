// SPDX-License-Identifier: AGPL-3.0-or-later

import {createChannelID, createUserID} from '@app/api/BrandedTypes';
import {ThreadPolicyRepository} from '@app/api/channel/services/thread/ThreadPolicyRepository';
import {ThreadPolicyService} from '@app/api/channel/services/thread/ThreadPolicyService';
import {afterEach, describe, expect, it, vi} from 'vitest';

describe('thread scoped penalties', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});
	it('denies sending and creating while allowing body edits under a user penalty', async () => {
		vi.stubEnv('FLUXER_THREAD_POLICY_ENABLED', 'true');
		const repository = new ThreadPolicyRepository();
		vi.spyOn(repository, 'list').mockResolvedValue([
			{source: 'forum_user_mute', kind: 'deny_send', active: true, version: 1, expires_at: null},
		]);
		const policy = new ThreadPolicyService(repository);
		await expect(policy.assertAllowed(createChannelID(1n), createUserID(2n), 'send')).rejects.toThrow();
		await expect(policy.assertAllowed(createChannelID(1n), createUserID(2n), 'create')).rejects.toThrow();
		await expect(policy.assertAllowed(createChannelID(1n), createUserID(2n), 'edit')).resolves.toBeUndefined();
	});
	it('keeps independently sourced locks effective and ignores expired or released restrictions', async () => {
		vi.stubEnv('FLUXER_THREAD_POLICY_ENABLED', 'true');
		const repository = new ThreadPolicyRepository();
		const list = vi.spyOn(repository, 'list').mockResolvedValue([
			{source: 'forum_soft_delete', kind: 'lock', active: false, version: 2, expires_at: null},
			{source: 'forum_work_lock', kind: 'lock', active: true, version: 1, expires_at: null},
		]);
		const policy = new ThreadPolicyService(repository);
		await expect(policy.assertAllowed(createChannelID(1n), createUserID(2n), 'edit')).rejects.toThrow();
		list.mockResolvedValue([
			{source: 'forum_work_lock', kind: 'lock', active: true, version: 3, expires_at: new Date(0)},
		]);
		await expect(policy.assertAllowed(createChannelID(1n), createUserID(2n), 'edit')).resolves.toBeUndefined();
	});
});
