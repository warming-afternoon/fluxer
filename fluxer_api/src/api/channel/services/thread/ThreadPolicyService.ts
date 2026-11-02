// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ChannelID, UserID} from '@app/api/BrandedTypes';
import {ThreadPolicyRepository} from '@app/api/channel/services/thread/ThreadPolicyRepository';
import {MissingPermissionsError} from '@fluxer/errors/src/domains/core/MissingPermissionsError';

export class ThreadPolicyService {
	/** 注入策略仓储以共享原生与集成入口的规则 */
	constructor(private readonly repository = new ThreadPolicyRepository()) {}

	/** 处罚仅禁止发言和新建子帖，锁额外禁止正文编辑 */
	async assertAllowed(
		channelId: ChannelID,
		userId: UserID,
		action: 'send' | 'create' | 'edit',
		{initializingStarter = false}: {initializingStarter?: boolean} = {},
	): Promise<void> {
		if (process.env.FLUXER_THREAD_POLICY_ENABLED !== 'true') return;
		const policies = await this.repository.list(channelId, userId);
		const now = Date.now();
		for (const policy of policies) {
			if (!policy.active || (policy.expires_at && policy.expires_at.getTime() <= now)) continue;
			if (initializingStarter && policy.source === 'forum_initializing' && policy.kind === 'lock') continue;
			if (policy.kind === 'lock' || action !== 'edit') throw new MissingPermissionsError();
		}
	}
}
