// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ReadStatePrincipal} from '@app/api/auth/ReadStatePrincipal';
import type {UserID} from '@app/api/BrandedTypes';
import {fetchOne} from '@app/api/database/CassandraQueryExecution';
import type {UserRow} from '@app/api/database/types/UserTypes';
import {Users} from '@app/api/Tables';

const FETCH_READ_STATE_PRINCIPAL = Users.select({
	columns: ['user_id', 'bot', 'flags', 'deletion_started_at', 'temp_banned_until', 'locale'],
	where: Users.where.eq('user_id'),
	limit: 1,
});
type PrincipalRow = Pick<UserRow, 'user_id' | 'bot' | 'flags' | 'deletion_started_at' | 'temp_banned_until' | 'locale'>;

/** 每次已读认证直接读取必要字段，不增加用户缓存或放宽撤销和封禁检查。 */
export class ReadStatePrincipalRepository {
	/** 保留原字段空值规则，仅创建窄身份数据。 */
	async findUnique(userId: UserID): Promise<ReadStatePrincipal | null> {
		const row = await fetchOne<PrincipalRow>(FETCH_READ_STATE_PRINCIPAL.bind({user_id: userId}));
		return row
			? {
					id: row.user_id,
					isBot: row.bot ?? false,
					flags: row.flags ?? 0n,
					deletionStartedAt: row.deletion_started_at ?? null,
					tempBannedUntil: row.temp_banned_until ?? null,
					locale: row.locale ?? null,
				}
			: null;
	}
}
