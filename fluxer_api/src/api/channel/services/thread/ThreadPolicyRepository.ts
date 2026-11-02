// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ChannelID, UserID} from '@app/api/BrandedTypes';
import {getClient} from '@pkgs/cassandra/src/Client';
import cassandra from 'cassandra-driver';

export interface ThreadPolicy {
	/** 独立限制来源 */
	source: string;

	/** 发言处罚或外部锁 */
	kind: 'deny_send' | 'lock';

	/** 撤销后保留版本以拒绝迟到覆盖 */
	active: boolean;

	/** 来源内单调版本 */
	version: number;

	/** 到期时间，空值表示永久 */
	expires_at: Date | null;
}

const OPTIONS = {
	prepare: true,
	consistency: cassandra.types.consistencies.localQuorum,
	serialConsistency: cassandra.types.consistencies.localSerial,
};

export class ThreadPolicyVersionConflictError extends Error {}

export class ThreadPolicyRepository {
	/** 读取 thread 级锁及用户处罚，不改变原生锁字段 */
	async list(channelId: ChannelID, userId: UserID): Promise<Array<ThreadPolicy>> {
		const result = await getClient().execute(
			'SELECT source, kind, active, version, expires_at FROM thread_external_policies WHERE thread_id = ? AND user_id IN ?',
			[channelId, [0n, userId]],
			OPTIONS,
		);
		return result.rows as unknown as Array<ThreadPolicy>;
	}

	/** 按来源版本条件写入，旧任务不能撤销更新的限制 */
	async set(channelId: ChannelID, userId: bigint, policy: ThreadPolicy): Promise<void> {
		for (let attempt = 0; attempt < 8; attempt++) {
			const response = await getClient().execute(
				'SELECT version, kind, active, expires_at FROM thread_external_policies WHERE thread_id = ? AND user_id = ? AND source = ?',
				[channelId, userId, policy.source],
				OPTIONS,
			);
			const row = response.first();
			const previous = row?.version == null ? undefined : Number(row.version);
			if (previous === policy.version) {
				if (
					row?.kind !== policy.kind ||
					row?.active !== policy.active ||
					(row?.expires_at?.getTime() ?? null) !== (policy.expires_at?.getTime() ?? null)
				)
					throw new ThreadPolicyVersionConflictError('Same policy version has a different payload');
				return;
			}
			if (previous !== undefined && previous > policy.version) return;
			const result =
				previous === undefined
					? await getClient().execute(
							'INSERT INTO thread_external_policies (thread_id, user_id, source, kind, active, version, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?) IF NOT EXISTS',
							[channelId, userId, policy.source, policy.kind, policy.active, policy.version, policy.expires_at],
							OPTIONS,
						)
					: await getClient().execute(
							'UPDATE thread_external_policies SET kind = ?, active = ?, version = ?, expires_at = ? WHERE thread_id = ? AND user_id = ? AND source = ? IF version = ?',
							[
								policy.kind,
								policy.active,
								policy.version,
								policy.expires_at,
								channelId,
								userId,
								policy.source,
								previous,
							],
							OPTIONS,
						);
			if (result.wasApplied()) return;
		}
		throw new Error('Thread policy contention');
	}
}
