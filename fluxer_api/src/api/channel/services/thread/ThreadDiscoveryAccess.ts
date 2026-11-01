// SPDX-License-Identifier: AGPL-3.0-or-later

import type {UserID} from '@app/api/BrandedTypes';
import type {AuthenticatedChannel} from '@app/api/channel/services/AuthenticatedChannel';
import type {ThreadServiceContext} from '@app/api/channel/services/thread/ThreadServiceContext';
import type {ThreadState} from '@app/api/models/ThreadState';
import {
	canViewThread,
	isThreadModerator,
	type ThreadActor,
	withImplicitThreadBits,
} from '@fluxer/constants/src/ThreadPermissionUtils';

/** 批量验证真实频道归属并复用父授权，公开帖子无需读取关注关系。 */
export async function filterThreadDiscoveryStates(
	ctx: Pick<ThreadServiceContext, 'channelRepository' | 'parentActor'>,
	parentAuth: AuthenticatedChannel,
	userId: UserID,
	states: ReadonlyArray<ThreadState>,
	actor?: ThreadActor,
): Promise<Array<ThreadState>> {
	if (!parentAuth.guild || states.length === 0) return [];
	const parent = parentAuth.channel;
	const candidates = states.filter((state) => state.parentId === parent.id && state.guildId === parent.guildId);
	if (candidates.length === 0) return [];
	const [parentActor, channels] = await Promise.all([
		actor ?? ctx.parentActor(parentAuth, userId),
		ctx.channelRepository.channelData.listChannels(candidates.map((state) => state.threadId)),
	]);
	const moderator = isThreadModerator(withImplicitThreadBits(parentActor.permissions), parentActor);
	// 私有线程继续使用原有成员或管理权限规则，公开目录不以关注为门槛。
	const joined = new Set(
		!moderator && candidates.some((state) => state.isPrivate)
			? await ctx.channelRepository.threads.listJoinedThreadIds(userId, parent.guildId!)
			: [],
	);
	const byId = new Map(channels.map((channel) => [channel.id, channel]));
	return candidates.filter((state) => {
		const channel = byId.get(state.threadId);
		if (
			!channel ||
			channel.guildId !== parent.guildId ||
			channel.parentId !== parent.id ||
			channel.type !== state.type
		) {
			return false;
		}
		return (
			canViewThread({
				...parentActor,
				thread: {type: state.type, archived: state.archived, locked: state.locked, invitable: state.invitable ?? true},
				isThreadOwner: channel.ownerId === userId,
				isMember: joined.has(state.threadId),
			}) === null
		);
	});
}
