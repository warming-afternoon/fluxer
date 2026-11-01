// SPDX-License-Identifier: AGPL-3.0-or-later

import type {GuildID, MessageID, UserID} from '@app/api/BrandedTypes';
import {dispatchChannelEvent, withThreadContext} from '@app/api/channel/services/ChannelGatewayDispatch';
import {createMessageResponseDataService} from '@app/api/channel/services/message/MessageResponseDataService';
import {
	getAttachedThreadMentionDecision,
	ThreadMentionDecisionService,
} from '@app/api/channel/services/message/ThreadMentionDecisionService';
import type {IGatewayService} from '@app/api/infrastructure/IGatewayService';
import type {Channel} from '@app/api/models/Channel';
import type {Message} from '@app/api/models/Message';
import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import {THREAD_CHANNEL_TYPES} from '@fluxer/constants/src/ThreadConstants';
import type {MessageResponse} from '@fluxer/schema/src/domains/message/MessageResponseSchemas';

interface BuildBroadcastMessageDataParams {
	channel: Channel;
	message: Message;
	currentUserId?: UserID;
	nonce?: string;
	tts?: boolean;
	sourceGuildId?: GuildID | null;
}

interface BuildBroadcastMessageCreateDataParams extends BuildBroadcastMessageDataParams {
	mentionHere?: boolean;
}

type MessageCreateBroadcastData = MessageResponse & {
	channel_type: Channel['type'];
	nicks?: Record<string, string>;
	mention_here?: true;
};

export async function buildBroadcastMessageData({
	channel,
	message,
	currentUserId,
	nonce,
	tts,
	sourceGuildId,
}: BuildBroadcastMessageDataParams): Promise<MessageResponse> {
	return createMessageResponseDataService().buildBroadcastMessage({
		channel,
		message,
		userId: currentUserId,
		nonce,
		tts,
		sourceGuildId,
	});
}

async function buildBroadcastMessageCreateData(
	params: BuildBroadcastMessageCreateDataParams,
): Promise<MessageCreateBroadcastData> {
	const messageResponse = await buildBroadcastMessageData(params);
	const groupDmNicks = serializeGroupDmNicks(params.channel);
	return {
		...messageResponse,
		channel_type: params.channel.type,
		...(groupDmNicks ? {nicks: groupDmNicks} : {}),
		...(params.mentionHere ? {mention_here: true} : {}),
	};
}

function serializeGroupDmNicks(channel: Channel): Record<string, string> | undefined {
	if (channel.type !== ChannelTypes.GROUP_DM || !channel.nicknames || channel.nicknames.size === 0) {
		return undefined;
	}
	const nicks: Record<string, string> = {};
	for (const [userId, nickname] of channel.nicknames) {
		nicks[String(userId)] = nickname;
	}
	return Object.keys(nicks).length > 0 ? nicks : undefined;
}

export async function dispatchMessageCreateBroadcast({
	gatewayService,
	...params
}: BuildBroadcastMessageCreateDataParams & {
	gatewayService: IGatewayService;
}): Promise<void> {
	await new ThreadMentionDecisionService().ensure(params.channel, params.message, gatewayService);
	const threadDecision = getAttachedThreadMentionDecision(params.message);
	const broadcastData = await buildBroadcastMessageCreateData(params);
	if (params.channel.guildId && THREAD_CHANNEL_TYPES.has(params.channel.type)) {
		// 专用协议不能回退到旧广播入口，避免旧网关泄露私有决策或恢复普通消息Push。
		await gatewayService.dispatchThreadMessage({
			guildId: params.channel.guildId,
			data: withThreadContext(params.channel, {
				...broadcastData,
				...(threadDecision ? {_thread_mention_decision: threadDecision} : {}),
			}),
		});
		return;
	}
	await dispatchChannelEvent({
		gatewayService,
		channel: params.channel,
		event: 'MESSAGE_CREATE',
		data: broadcastData,
	});
}

export async function dispatchMessageCreateToUser({
	gatewayService,
	userId,
	...params
}: BuildBroadcastMessageCreateDataParams & {
	gatewayService: IGatewayService;
	userId: UserID;
}): Promise<void> {
	await gatewayService.dispatchPresence({
		userId,
		event: 'MESSAGE_CREATE',
		data: await buildBroadcastMessageCreateData(params),
	});
}

export async function dispatchMessageUpdateBroadcast({
	gatewayService,
	...params
}: BuildBroadcastMessageDataParams & {
	gatewayService: IGatewayService;
}): Promise<void> {
	await dispatchChannelEvent({
		gatewayService,
		channel: params.channel,
		event: 'MESSAGE_UPDATE',
		data: await buildBroadcastMessageData(params),
	});
}

export async function dispatchMessageDelete({
	gatewayService,
	channel,
	messageId,
	message,
}: {
	gatewayService: IGatewayService;
	channel: Channel;
	messageId: MessageID;
	message: Message;
}): Promise<void> {
	await dispatchChannelEvent({
		gatewayService,
		channel,
		event: 'MESSAGE_DELETE',
		data: {
			channel_id: channel.id.toString(),
			id: messageId.toString(),
			content: message.content,
			author_id: message.authorId?.toString(),
		},
	});
}

export async function dispatchMessageDeleteBulk({
	gatewayService,
	channel,
	messageIds,
}: {
	gatewayService: IGatewayService;
	channel: Channel;
	messageIds: Array<MessageID>;
}): Promise<void> {
	await dispatchChannelEvent({
		gatewayService,
		channel,
		event: 'MESSAGE_DELETE_BULK',
		data: {
			channel_id: channel.id.toString(),
			ids: messageIds.map((id) => id.toString()),
		},
	});
}
