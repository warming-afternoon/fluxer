// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID, type UserID} from '@app/api/BrandedTypes';
import {getUserRepository} from '@app/api/middleware/ServiceSingletons';
import {IntegrationEventJournal} from '@app/integration/IntegrationEventJournal';

/** 账号写入前保留安全状态跟踪，发布进程崩溃后仍能发现权威变化 */
export async function prepareIntegrationUserChange(userId: UserID): Promise<void> {
	// 未启用集成时不创建外部事件的持久跟踪记录。
	if (!process.env.INTEGRATION_NATS_URL) return;
	await new IntegrationEventJournal().track(`user:${userId}`, {user_id: userId.toString()});
}

/** 只对安全相关字段分配单调事件版本，普通资料修改不会产生重复失效风暴 */
export async function projectIntegrationUser(userId: string): Promise<void> {
	// 从原生权威账户重建安全快照，不将普通资料字段纳入失效判断。
	const user = await getUserRepository().findUnique(createUserID(BigInt(userId)));
	await new IntegrationEventJournal().snapshot(`user:${userId}`, 'events.auth.v1.user_invalidated', {
		user_id: userId,
		security: {
			exists: !!user,
			flags: user?.flags.toString() ?? null,
			temp_banned_until: user?.tempBannedUntil?.toISOString() ?? null,
			pending_deletion_at: user?.pendingDeletionAt?.toISOString() ?? null,
			registration_pending: user?.traits.has('registration_pending_approval') ?? false,
			registration_rejected: user?.traits.has('registration_rejected') ?? false,
		},
	});
}
