// SPDX-License-Identifier: AGPL-3.0-or-later

import type {Channel} from '@app/features/channel/models/Channel';
import Channels from '@app/features/channel/state/Channels';
import ThreadMemberships from '@app/features/threads/state/ThreadMemberships';
import UserGuildSettings from '@app/features/user/state/UserGuildSettings';
import {MessageNotifications} from '@fluxer/constants/src/NotificationConstants';
import {ThreadMemberFlags} from '@fluxer/constants/src/ThreadConstants';

export const ThreadNotificationSetting = {
	DEFAULT: 'default',
	ALL_MESSAGES: 'all_messages',
	ONLY_MENTIONS: 'only_mentions',
	NO_MESSAGES: 'no_messages',
} as const;

export type ThreadNotificationSetting = (typeof ThreadNotificationSetting)[keyof typeof ThreadNotificationSetting];

export function getThreadParent(thread: Channel): Channel | undefined {
	return thread.parentId ? Channels.getChannel(thread.parentId) : undefined;
}

function isThreadParentMuted(thread: Channel): boolean {
	return thread.parentId != null && UserGuildSettings.isMutedAtAnyLevel(thread.guildId ?? null, thread.parentId);
}

export function isThreadMutedInSidebar(thread: Channel): boolean {
	return (
		ThreadMemberships.isMuted(thread.id) ||
		(thread.parentId != null && UserGuildSettings.isChannelDirectlyMuted(thread.guildId ?? null, thread.parentId))
	);
}

export function isThreadMuted(thread: Channel): boolean {
	return ThreadMemberships.isMuted(thread.id) || isThreadParentMuted(thread);
}

/** 将旧全部通知归一为仅提及，默认值只继承父级关闭状态。 */
export function getThreadNotificationSetting(threadId: string): ThreadNotificationSetting {
	const flags = ThreadMemberships.get(threadId)?.flags ?? 0;
	if ((flags & ThreadMemberFlags.NO_MESSAGES) !== 0) return ThreadNotificationSetting.NO_MESSAGES;
	if ((flags & (ThreadMemberFlags.ALL_MESSAGES | ThreadMemberFlags.ONLY_MENTIONS)) === 0) {
		const thread = Channels.getChannel(threadId);
		const parent = thread ? getThreadParent(thread) : undefined;
		if (
			parent &&
			UserGuildSettings.resolveEffectiveMessageNotifications({
				id: parent.id,
				guildId: parent.guildId,
				parentId: parent.parentId ?? undefined,
				type: parent.type,
			}) === MessageNotifications.NO_MESSAGES
		) {
			return ThreadNotificationSetting.NO_MESSAGES;
		}
	}
	return ThreadNotificationSetting.ONLY_MENTIONS;
}

/** 所有历史可写值都只提交仅提及或关闭，不能重新写入全部消息。 */
export function getThreadNotificationFlag(setting: ThreadNotificationSetting): number {
	switch (setting) {
		case ThreadNotificationSetting.NO_MESSAGES:
			return ThreadMemberFlags.NO_MESSAGES;
		default:
			return ThreadMemberFlags.ONLY_MENTIONS;
	}
}

/** 帖子普通消息不能由父级全部消息设置恢复通知。 */
export function resolveThreadNotificationLevel(thread: Channel): number {
	return getThreadNotificationSetting(thread.id) === ThreadNotificationSetting.NO_MESSAGES
		? MessageNotifications.NO_MESSAGES
		: MessageNotifications.ONLY_MENTIONS;
}
