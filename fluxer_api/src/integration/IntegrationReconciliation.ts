// SPDX-License-Identifier: AGPL-3.0-or-later

import {type ChannelID, createChannelID} from '@app/api/BrandedTypes';
import {ChannelRepository} from '@app/api/channel/ChannelRepository';
import {projectIntegrationUser} from '@app/integration/IntegrationAuthEvents';
import {prepareIntegrationContentChange, projectIntegrationContent} from '@app/integration/IntegrationContentEvents';
import {IntegrationEventJournal} from '@app/integration/IntegrationEventJournal';
import {INTEGRATION_QUERY_OPTIONS} from '@app/integration/IntegrationIdentityRepository';
import {getClient} from '@pkgs/cassandra/src/Client';

/** 有界扫描论坛和关联身份，补齐未被新写入触发的历史资源投影 */
export class IntegrationReconciliation {
	/** 当前轮次待扫描的论坛索引 */
	private parent = 0;

	/** 当前论坛已处理的最后一个子频道 */
	private after: ChannelID | undefined;

	/** 下一轮完整论坛扫描的最早时间 */
	private nextForumPass = 0;

	/** 下一页身份扫描的最早时间 */
	private nextIdentityPage = 0;

	/** 权威身份索引的 Cassandra 分页游标 */
	private identityCursor: string | undefined;

	/** 启动扫描和每十分钟的一轮论坛对账按页推进，历史资源不会只靠新写入才被跟踪 */
	async step(): Promise<void> {
		const forums = (process.env.INTEGRATION_FORUM_CHANNEL_IDS ?? '').split(',').filter(Boolean);
		if (forums.length === 4 && process.env.INTEGRATION_GUILD_ID && Date.now() >= this.nextForumPass) {
			const parent = createChannelID(BigInt(forums[this.parent]!));
			const ids = await new ChannelRepository().threads.listThreadIdsByParent(parent, {after: this.after, limit: 20});
			for (const id of ids) {
				const resource = {
					guild_id: process.env.INTEGRATION_GUILD_ID,
					channel_id: parent.toString(),
					thread_id: id.toString(),
				};
				await prepareIntegrationContentChange(id, resource);
				await projectIntegrationContent(resource);
			}
			// 页满时继续当前论坛，末页才前进到下一个论坛。
			this.after = ids.length === 20 ? ids[ids.length - 1] : undefined;
			if (ids.length < 20) this.parent++;
			if (this.parent === 4) {
				this.parent = 0;
				this.nextForumPass = Date.now() + 600_000;
			}
		}
		if (Date.now() < this.nextIdentityPage) return;
		// 只扫描已关联身份的权威索引，不扫描所有原生用户或历史操作日志。
		const response = await getClient().execute('SELECT user_id FROM integration_user_identities', [], {
			...INTEGRATION_QUERY_OPTIONS,
			fetchSize: 100,
			pageState: this.identityCursor,
		});
		for (const row of response.rows) {
			if (!row.user_id) continue;
			const userId = row.user_id.toString();
			await new IntegrationEventJournal().track(`user:${userId}`, {user_id: userId});
			await projectIntegrationUser(userId);
		}
		this.identityCursor = response.pageState;
		this.nextIdentityPage = Date.now() + (this.identityCursor ? 30_000 : 600_000);
	}
}
