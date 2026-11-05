// SPDX-License-Identifier: AGPL-3.0-or-later

import type {GuildID} from '@app/api/BrandedTypes';
import {getCacheService} from '@app/api/middleware/ServiceSingletons';
import {ResourceLockedError} from '@fluxer/errors/src/domains/core/ResourceLockedError';

/** Join and moderation share the same lock, including member-count updates. */
export async function withGuildMembershipLock<T>(
	guildId: GuildID,
	apply: (assertHeld: () => Promise<void>) => Promise<T>,
): Promise<T> {
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
	const assertHeld = async () => {
		if (!(await cache.extendLock(key, token, 120))) throw new ResourceLockedError();
	};
	try {
		const result = await apply(assertHeld);
		await assertHeld();
		return result;
	} finally {
		await cache.releaseLock(key, token);
	}
}
