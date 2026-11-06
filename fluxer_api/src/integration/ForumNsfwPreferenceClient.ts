// SPDX-License-Identifier: AGPL-3.0-or-later

import {randomUUID} from 'node:crypto';
import type {GuildID, UserID} from '@app/api/BrandedTypes';
import {forumNsfwGuildId} from '@app/api/user/NsfwDisplayScope';
import {IntegrationError} from '@app/integration/IntegrationError';
import {getIntegrationNatsConnection} from '@app/integration/IntegrationNatsConnection';

export const FORUM_NSFW_APPLY_SUBJECT = 'rpc.forum.v1.nsfw.apply';
// 限制进程内同时等待论坛确认的请求，避免积压。
let inflight = 0;

/** 以原生 CAS 版本同步论坛偏好，仅接受与本次请求完全匹配的确认。 */
export async function syncForumNsfwPreference(
	userId: UserID,
	guildId: GuildID,
	show: boolean,
	version: number,
): Promise<void> {
	if (guildId.toString() !== forumNsfwGuildId())
		throw new IntegrationError('RESOURCE_NOT_ALLOWED', 'Preference is restricted to the configured Forum guild');
	if (typeof show !== 'boolean' || !Number.isSafeInteger(version) || version < 1)
		throw new IntegrationError('INVALID_REQUEST', 'Invalid preference value or version');
	if (inflight >= 32) throw unavailable();
	inflight++;
	try {
		const connection = await getIntegrationNatsConnection();
		const response = await connection.request(
			FORUM_NSFW_APPLY_SUBJECT,
			JSON.stringify({
				version: 1,
				request_id: randomUUID(),
				user_id: userId.toString(),
				guild_id: guildId.toString(),
				show_nsfw: show,
				nsfw_version: version,
			}),
			{timeout: 8000},
		);
		if (response.data.length > 4096) throw unavailable();
		const ack: unknown = JSON.parse(response.string());
		if (!ack || typeof ack !== 'object' || !('ok' in ack) || ack.ok !== true || !('data' in ack)) throw unavailable();
		const data = ack.data;
		if (
			!data ||
			typeof data !== 'object' ||
			!('user_id' in data) ||
			data.user_id !== userId.toString() ||
			!('guild_id' in data) ||
			data.guild_id !== guildId.toString() ||
			!('show_nsfw' in data) ||
			data.show_nsfw !== show ||
			!('nsfw_version' in data) ||
			data.nsfw_version !== version
		) {
			// 更新版本不能确认本次请求，保留持久化意图以便恢复流程同步最新原生版本。
			throw unavailable();
		}
	} catch {
		// 统一转换错误，避免泄露消息代理凭据或远端错误文本。
		throw unavailable();
	} finally {
		inflight--;
	}
}

/** 统一构造可重试的未确认错误，保持各校验分支的错误契约一致。 */
function unavailable(): IntegrationError {
	return new IntegrationError('UNAVAILABLE', 'Forum preference synchronization is unconfirmed', true);
}
