// SPDX-License-Identifier: AGPL-3.0-or-later

import {createChannelID} from '@app/api/BrandedTypes';
import {getChannelMetadata} from '@app/api/database/CassandraQueryExecution';
import {userViewerActive, viewerFromCtx} from '@app/api/experiment/ChannelThreadsGate';
import type {HonoEnv} from '@app/api/types/HonoEnv';
import {AppNotFoundHandler} from '@fluxer/errors/src/domains/core/ErrorHandlers';
import type {Context} from 'hono';
import {createMiddleware} from 'hono/factory';

const SNOWFLAKE_PARAM = /^\d{1,20}$/;

/** 检查调用者是否具备线程能力及路由要求的机器人身份。 */
function callerActive(ctx: Context<HonoEnv>, botOnly: boolean): boolean {
	const user = ctx.get('user');
	if (!user || (botOnly && !user.isBot)) return false;
	return userViewerActive(viewerFromCtx(ctx));
}

/** 显式解析频道所属社区，不依赖前置中间件填充完整频道缓存。 */
async function pathGuildActive(ctx: Context<HonoEnv>): Promise<boolean> {
	const guildId = ctx.req.param('guild_id');
	if (guildId !== undefined) {
		return SNOWFLAKE_PARAM.test(guildId);
	}
	const channelId = ctx.req.param('channel_id');
	if (channelId === undefined) return true;
	if (!SNOWFLAKE_PARAM.test(channelId)) return false;
	const id = createChannelID(BigInt(channelId));
	const channel = ctx.get('requestCache').channels.get(id);
	// null表示已查明频道不存在，undefined才表示尚未加载。
	if (channel !== undefined) return channel?.guildId != null;
	const metadata = getChannelMetadata([id]);
	if (metadata !== null) return (await metadata).get(id)?.guildId != null;
	// 元数据能力未提供时回源，完整频道权限仍由后续业务处理。
	return (await ctx.get('channelRepository').channelData.findUnique(id))?.guildId != null;
}

/** 在进入线程处理前检查调用者资格和路径对应的社区频道。 */
export function ChannelThreadsRouteGuard(options: {botOnly?: boolean} = {}) {
	const botOnly = options.botOnly ?? false;
	return createMiddleware<HonoEnv>(async (ctx, next) => {
		if (!callerActive(ctx, botOnly) || !(await pathGuildActive(ctx))) {
			return AppNotFoundHandler(ctx);
		}
		return next();
	});
}
