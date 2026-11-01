// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	type ChannelID,
	channelIdToMessageId,
	createMessageID,
	type GuildID,
	type MessageID,
	type UserID,
} from '@app/api/BrandedTypes';
import type {ReadStateRow} from '@app/api/database/types/ChannelTypes';
import {ReadStateFlags} from '@fluxer/constants/src/ThreadConstants';

export interface ReadStateMutationMarker {
	/** 帖子标记 */
	flags: number;

	/** 所属社区 */
	guildId: GuildID;
}

interface ReadStateMutationKey {
	/** 已通过业务层验证的用户 */
	userId: UserID;

	/** 已读状态所属频道 */
	channelId: ChannelID;

	/** 可选的论坛可见性标记 */
	marker?: ReadStateMutationMarker | null;
}

export type ReadStateMutation =
	| (ReadStateMutationKey & {
			/** 普通或手动确认 */
			kind: 'ack';

			/** 读到的消息位置 */
			messageId: MessageID;

			/** 确认后的提及数 */
			mentionCount: number;

			/** 是否允许主动回退位置 */
			manual?: boolean;

			/** 同步确认的置顶时间 */
			lastPinTimestamp?: Date;
	  })
	| (ReadStateMutationKey & {
			/** 新消息提及 */
			kind: 'mention';

			/** 触发提及的消息 */
			messageId: MessageID;
	  })
	| (ReadStateMutationKey & {
			/** 确认置顶 */
			kind: 'pin';

			/** 已确认的置顶时间 */
			lastPinTimestamp: Date;
	  })
	| {
			/** 清除该用户的全部已读状态 */
			kind: 'deleteUser';

			/** 待清除的用户 */
			userId: UserID;
	  };

export interface ReadStateMutationResult {
	/** 该操作之前的逻辑状态 */
	previous: ReadStateRow | null;

	/** 该操作之后的逻辑状态 */
	row: ReadStateRow | null;

	/** 是否需要更新存储 */
	applied: boolean;
}

/** 顺序计算一次变更，避免普通确认、手动回退与提及计数相互覆盖 */
export function reduceReadStateMutation(
	mutation: Exclude<ReadStateMutation, {kind: 'deleteUser'}>,
	previous: ReadStateRow | null,
): ReadStateMutationResult {
	// 合并已有行而不重建无关字段，保留置顶时间及未来增加的状态。
	const row: ReadStateRow = previous
		? {...previous}
		: {
				user_id: mutation.userId,
				channel_id: mutation.channelId,
				message_id: null,
				mention_count: 0,
				last_pin_timestamp: null,
			};
	const marker = mutation.marker;
	const stamp = marker != null && (previous?.guild_id == null || previous.flags !== marker.flags);
	if (mutation.kind === 'mention') {
		if (previous?.message_id != null && previous.message_id >= mutation.messageId) {
			return {previous, row: previous, applied: false};
		}
		if (!previous) {
			const baseline = channelIdToMessageId(mutation.channelId);
			row.message_id =
				marker && (marker.flags & ReadStateFlags.IS_THREAD) !== 0 ? createMessageID(baseline - 1n) : baseline;
			if (row.message_id >= mutation.messageId) return {previous, row: null, applied: false};
		}
		row.mention_count = (previous?.mention_count ?? 0) + 1;
	} else if (mutation.kind === 'pin') {
		row.last_pin_timestamp = mutation.lastPinTimestamp;
		if (marker) Object.assign(row, {flags: marker.flags, guild_id: marker.guildId});
	} else {
		// 普通确认只前进，手动标未读按队列顺序保留回退语义。
		if (!mutation.manual && previous?.message_id != null && previous.message_id > mutation.messageId) {
			if (!stamp) return {previous, row: previous, applied: false};
		} else {
			row.message_id = mutation.messageId;
			row.mention_count = mutation.mentionCount;
			if (mutation.lastPinTimestamp !== undefined) row.last_pin_timestamp = mutation.lastPinTimestamp;
		}
	}
	if (stamp) Object.assign(row, {flags: marker.flags, guild_id: marker.guildId});
	return {previous, row, applied: true};
}
