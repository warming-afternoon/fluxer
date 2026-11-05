// SPDX-License-Identifier: AGPL-3.0-or-later

import type {GuildID} from '@app/api/BrandedTypes';
import {getCacheService} from '@app/api/middleware/ServiceSingletons';
import {ResourceLockedError} from '@fluxer/errors/src/domains/core/ResourceLockedError';

/** 加入与成员管理共用同一把锁，覆盖成员数量更新。 */
export async function withGuildMembershipLock<T>(
	guildId: GuildID,
	apply: (assertHeld: () => Promise<void>) => Promise<T>,
): Promise<T> {
	// 有限等待共享租约，避免并发成员操作交错提交。
	const cache = getCacheService();
	const key = `guild:${guildId}:membership`;
	let token: string | null = null;
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		token = await cache.acquireLock(key, 120);
		if (token) break;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	if (!token) throw new ResourceLockedError();
	/** 续租并确认当前操作仍持有成员锁。 */
	const assertHeld = async () => {
		// 续租失败立即中断，避免失锁后继续修改成员状态。
		if (!(await cache.extendLock(key, token, 120))) throw new ResourceLockedError();
	};
	try {
		const result = await apply(assertHeld);
		// 返回结果前再次确认租约，释放锁则始终在退出时执行。
		await assertHeld();
		return result;
	} finally {
		await cache.releaseLock(key, token);
	}
}
