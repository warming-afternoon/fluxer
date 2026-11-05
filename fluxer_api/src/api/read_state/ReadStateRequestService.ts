// SPDX-License-Identifier: AGPL-3.0-or-later

import type {UserID} from '@app/api/BrandedTypes';
import {createChannelID, createMessageID} from '@app/api/BrandedTypes';
import {mapReadStateResponse} from '@app/api/read_state/ReadStateResponseMapper';
import type {ReadStateService} from '@app/api/read_state/ReadStateService';
import {filterNsfwReadStates} from '@app/api/read_state/ReadStateVisibility';
import type {
	ReadStateAckBulkRequest,
	ReadStateAckRequest,
	ReadStateAckResponse,
} from '@fluxer/schema/src/domains/channel/ChannelRequestSchemas';

interface ReadStateAckBulkParams {
	userId: UserID;
	data: ReadStateAckBulkRequest;
	capable?: boolean;
}

interface ReadStateAckParams {
	userId: UserID;
	data: ReadStateAckRequest;
	capable?: boolean;
}

export class ReadStateRequestService {
	constructor(private readStateService: ReadStateService) {}

	async bulkAckMessages({userId, data, capable}: ReadStateAckBulkParams): Promise<void> {
		await this.readStateService.bulkAckMessages({
			userId,
			capable,
			readStates: data.read_states.map((readState) => ({
				channelId: createChannelID(readState.channel_id),
				messageId: createMessageID(readState.message_id),
			})),
		});
	}

	/** 校验已读确认请求并过滤用户不可见频道的结果。 */
	async ackReadStates({userId, data, capable}: ReadStateAckParams): Promise<ReadStateAckResponse> {
		const readStates = await this.readStateService.ackReadStates({
			userId,
			capable,
			readStates: data.read_states.map((readState) => ({
				channelId: createChannelID(readState.channel_id),
				messageId: createMessageID(readState.message_id),
				mentionCount: readState.mention_count,
				manual: readState.manual,
			})),
		});
		return {
			read_states: (await filterNsfwReadStates(readStates, userId)).map(mapReadStateResponse),
		};
	}
}
