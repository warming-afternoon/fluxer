// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	type ChannelID,
	createChannelID,
	createMessageID,
	createUserID,
	type MessageID,
	type UserID,
} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import type {IGatewayService} from '@app/api/infrastructure/IGatewayService';
import {ReadState} from '@app/api/models/ReadState';
import type {ReadStateRepository} from '@app/api/read_state/ReadStateRepository';
import {ReadStateService} from '@app/api/read_state/ReadStateService';
import {BadGatewayError} from '@fluxer/errors/src/domains/core/BadGatewayError';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

let priorCombined = false;
beforeEach(() => {
	priorCombined = Config.readState!.combinedGatewayRpcEnabled;
	Config.readState!.combinedGatewayRpcEnabled = false;
});
afterEach(() => {
	Config.readState!.combinedGatewayRpcEnabled = priorCombined;
});

const USER_ID = createUserID(20n);
const CHANNEL_ID = createChannelID(21n);
const MESSAGE_ID = createMessageID(22n);

function makeReadState(channelId: ChannelID, messageId: MessageID, mentionCount = 0): ReadState {
	return new ReadState({
		user_id: USER_ID,
		channel_id: channelId,
		message_id: messageId,
		mention_count: mentionCount,
		last_pin_timestamp: null,
		version: 5n,
	});
}

describe('ReadStateService gateway side effects after the write', () => {
	it('keeps a manual rollback notification behind an earlier delayed acknowledgement', async () => {
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const repository = {
			upsertReadState: vi.fn(async (_user: UserID, channel: ChannelID, message: MessageID) => ({
				readState: makeReadState(channel, message),
				previous: null,
			})),
		} as unknown as ReadStateRepository;
		const clear = vi
			.fn()
			.mockImplementationOnce(() => gate)
			.mockResolvedValue(undefined);
		const dispatch = vi.fn().mockResolvedValue(undefined);
		const service = new ReadStateService(repository, {
			clearPushChannelNotifications: clear,
			dispatchPresence: dispatch,
		} as unknown as IGatewayService);
		const first = service.ackMessage({
			userId: USER_ID,
			channelId: CHANNEL_ID,
			messageId: createMessageID(200n),
			mentionCount: 0,
		});
		const second = service.ackMessage({
			userId: USER_ID,
			channelId: CHANNEL_ID,
			messageId: createMessageID(150n),
			mentionCount: 0,
			manual: true,
		});
		await vi.waitFor(() => expect(clear).toHaveBeenCalledTimes(1));
		expect(dispatch).not.toHaveBeenCalled();
		release();
		await Promise.all([first, second]);
		expect(dispatch.mock.calls.map(([params]) => params.data.message_id)).toEqual(['200', '150']);
	});

	it('returns the committed read state when clearing push notifications fails', async () => {
		const stored: Array<{channelId: ChannelID; messageId: MessageID}> = [];
		const repository = {
			upsertReadState: vi.fn(async (_userId: UserID, channelId: ChannelID, messageId: MessageID) => {
				stored.push({channelId, messageId});
				return {readState: makeReadState(channelId, messageId), previous: null};
			}),
		} as unknown as ReadStateRepository;
		const gatewayService = {
			clearPushChannelNotifications: vi.fn().mockRejectedValue(new BadGatewayError()),
			dispatchPresence: vi.fn().mockResolvedValue(undefined),
		} as unknown as IGatewayService;
		const service = new ReadStateService(repository, gatewayService);

		const readState = await service.ackMessage({
			userId: USER_ID,
			channelId: CHANNEL_ID,
			messageId: MESSAGE_ID,
			mentionCount: 0,
		});

		expect(readState.channelId).toBe(CHANNEL_ID);
		expect(readState.lastMessageId).toBe(MESSAGE_ID);
		expect(stored).toEqual([{channelId: CHANNEL_ID, messageId: MESSAGE_ID}]);
		expect(gatewayService.dispatchPresence).toHaveBeenCalledTimes(1);
	});

	it('acknowledges the message when the MESSAGE_ACK dispatch fails', async () => {
		const repository = {
			upsertReadState: vi.fn(async (_userId: UserID, channelId: ChannelID, messageId: MessageID) => ({
				readState: makeReadState(channelId, messageId),
				previous: null,
			})),
		} as unknown as ReadStateRepository;
		const gatewayService = {
			clearPushChannelNotifications: vi.fn().mockResolvedValue(undefined),
			dispatchPresence: vi.fn().mockRejectedValue(new BadGatewayError()),
		} as unknown as IGatewayService;
		const service = new ReadStateService(repository, gatewayService);

		const readState = await service.ackMessage({
			userId: USER_ID,
			channelId: CHANNEL_ID,
			messageId: MESSAGE_ID,
			mentionCount: 0,
		});

		expect(readState.lastMessageId).toBe(MESSAGE_ID);
	});

	it('returns every entry of the entry-by-entry path when the dispatch fails', async () => {
		const stored: Array<string> = [];
		const repository = {
			upsertReadState: vi.fn(async (_userId: UserID, channelId: ChannelID, messageId: MessageID) => {
				stored.push(channelId.toString());
				return {readState: makeReadState(channelId, messageId, 1), previous: null};
			}),
		} as unknown as ReadStateRepository;
		const gatewayService = {
			clearPushChannelNotifications: vi.fn().mockResolvedValue(undefined),
			dispatchPresence: vi.fn().mockRejectedValue(new BadGatewayError()),
		} as unknown as IGatewayService;
		const service = new ReadStateService(repository, gatewayService);

		const readStates = await service.ackReadStates({
			userId: USER_ID,
			readStates: [
				{channelId: CHANNEL_ID, messageId: MESSAGE_ID, manual: true},
				{channelId: createChannelID(23n), messageId: createMessageID(24n), manual: true},
			],
		});

		expect(readStates.map((readState) => readState.channelId.toString())).toEqual(['21', '23']);
		expect(stored).toEqual(['21', '23']);
	});

	it('returns the bulk acknowledged states when clearing push notifications fails', async () => {
		const updated = [makeReadState(CHANNEL_ID, MESSAGE_ID)];
		const repository = {
			bulkAckMessages: vi.fn().mockResolvedValue(updated),
		} as unknown as ReadStateRepository;
		const gatewayService = {
			clearPushChannelNotifications: vi.fn().mockRejectedValue(new BadGatewayError()),
			dispatchPresence: vi.fn().mockResolvedValue(undefined),
		} as unknown as IGatewayService;
		const service = new ReadStateService(repository, gatewayService);

		const readStates = await service.bulkAckMessages({
			userId: USER_ID,
			readStates: [{channelId: CHANNEL_ID, messageId: MESSAGE_ID}],
		});

		expect(readStates).toBe(updated);
	});
});

describe('ReadStateService implicit acknowledgements', () => {
	async function implicitAck(params: {
		previous: ReadState | null;
		messageId: MessageID;
		unreadThrough: MessageID | null;
	}): Promise<Array<MessageID>> {
		const repository = {
			upsertReadState: vi.fn(async (_userId: UserID, channelId: ChannelID, messageId: MessageID) => ({
				readState: makeReadState(channelId, messageId),
				previous: params.previous,
			})),
		} as unknown as ReadStateRepository;
		const clearPushChannelNotifications = vi.fn().mockResolvedValue(undefined);
		const gatewayService = {
			clearPushChannelNotifications,
			dispatchPresence: vi.fn().mockResolvedValue(undefined),
		} as unknown as IGatewayService;
		await new ReadStateService(repository, gatewayService).ackMessage({
			userId: USER_ID,
			channelId: CHANNEL_ID,
			messageId: params.messageId,
			mentionCount: 0,
			implicit: {unreadThrough: params.unreadThrough},
			emitGateway: false,
		});
		return clearPushChannelNotifications.mock.calls.map(([call]) => call.messageId);
	}

	it('clears when the previous read state lagged the latest earlier message', async () => {
		const cleared = await implicitAck({
			previous: makeReadState(CHANNEL_ID, createMessageID(30n)),
			messageId: createMessageID(40n),
			unreadThrough: createMessageID(35n),
		});
		expect(cleared).toEqual([createMessageID(40n)]);
	});

	it('does not clear when the previous read state already covered the latest earlier message', async () => {
		const cleared = await implicitAck({
			previous: makeReadState(CHANNEL_ID, createMessageID(35n)),
			messageId: createMessageID(40n),
			unreadThrough: createMessageID(35n),
		});
		expect(cleared).toEqual([]);
	});

	it('clears when unread mentions remained', async () => {
		const cleared = await implicitAck({
			previous: makeReadState(CHANNEL_ID, createMessageID(35n), 2),
			messageId: createMessageID(40n),
			unreadThrough: createMessageID(35n),
		});
		expect(cleared).toEqual([createMessageID(40n)]);
	});

	it('does not clear when the read state was already past the acknowledged message', async () => {
		const cleared = await implicitAck({
			previous: makeReadState(CHANNEL_ID, createMessageID(50n), 2),
			messageId: createMessageID(40n),
			unreadThrough: createMessageID(40n),
		});
		expect(cleared).toEqual([]);
	});

	it('clears when there was no read state and the channel had earlier messages', async () => {
		const cleared = await implicitAck({
			previous: null,
			messageId: createMessageID(40n),
			unreadThrough: createMessageID(35n),
		});
		expect(cleared).toEqual([createMessageID(40n)]);
	});

	it('does not clear when there was no read state and no earlier message', async () => {
		const cleared = await implicitAck({previous: null, messageId: createMessageID(40n), unreadThrough: null});
		expect(cleared).toEqual([]);
	});

	it('does not wait for the push clear to finish', async () => {
		const repository = {
			upsertReadState: vi.fn(async (_userId: UserID, channelId: ChannelID, messageId: MessageID) => ({
				readState: makeReadState(channelId, messageId),
				previous: makeReadState(channelId, createMessageID(30n), 1),
			})),
		} as unknown as ReadStateRepository;
		const clearPushChannelNotifications = vi.fn(() => new Promise<void>(() => {}));
		const gatewayService = {clearPushChannelNotifications} as unknown as IGatewayService;
		const readState = await new ReadStateService(repository, gatewayService).ackMessage({
			userId: USER_ID,
			channelId: CHANNEL_ID,
			messageId: createMessageID(40n),
			mentionCount: 0,
			implicit: {unreadThrough: createMessageID(35n)},
			emitGateway: false,
		});
		expect(readState.lastMessageId).toBe(createMessageID(40n));
		expect(clearPushChannelNotifications).toHaveBeenCalledTimes(1);
	});
});

/** 合并调用只改变传输次数，保留权威游标、手动回退及写入后的副作用顺序。 */
describe('combined read-state gateway RPC', () => {
	it('uses one RPC after persistence and preserves the distinct clear and authoritative cursors', async () => {
		const {Config} = await import('@app/api/Config');
		const previous = Config.readState!.combinedGatewayRpcEnabled;
		Config.readState!.combinedGatewayRpcEnabled = true;
		try {
			const repository = {
				upsertReadState: vi.fn(async () => ({
					readState: makeReadState(CHANNEL_ID, createMessageID(30n)),
					previous: null,
				})),
			} as unknown as ReadStateRepository;
			const gateway = {
				acknowledgeReadState: vi.fn(async () => {}),
				clearPushChannelNotifications: vi.fn(),
				dispatchPresence: vi.fn(),
			} as unknown as IGatewayService;
			await new ReadStateService(repository, gateway).ackMessage({
				userId: USER_ID,
				channelId: CHANNEL_ID,
				messageId: MESSAGE_ID,
				mentionCount: 0,
			});
			expect(gateway.acknowledgeReadState).toHaveBeenCalledWith(
				expect.objectContaining({
					messageId: MESSAGE_ID,
					data: expect.objectContaining({message_id: '30', version: '5'}),
				}),
			);
			expect(gateway.clearPushChannelNotifications).not.toHaveBeenCalled();
			expect(gateway.dispatchPresence).not.toHaveBeenCalled();
			expect(vi.mocked(repository.upsertReadState).mock.invocationCallOrder[0]).toBeLessThan(
				vi.mocked(gateway.acknowledgeReadState).mock.invocationCallOrder[0]!,
			);
		} finally {
			Config.readState!.combinedGatewayRpcEnabled = previous;
		}
	});

	it('preserves per-user/channel ordering and database success when combined RPC fails', async () => {
		const {Config} = await import('@app/api/Config');
		const previous = Config.readState!.combinedGatewayRpcEnabled;
		Config.readState!.combinedGatewayRpcEnabled = true;
		try {
			const gate = Promise.withResolvers<void>();
			const rpc = vi.fn().mockReturnValueOnce(gate.promise).mockRejectedValueOnce(new Error('gateway unavailable'));
			const repository = {
				upsertReadState: vi.fn(async (_user: UserID, channel: ChannelID, message: MessageID) => ({
					readState: makeReadState(channel, message),
					previous: null,
				})),
			} as unknown as ReadStateRepository;
			const service = new ReadStateService(repository, {acknowledgeReadState: rpc} as unknown as IGatewayService);
			const first = service.ackMessage({
				userId: USER_ID,
				channelId: CHANNEL_ID,
				messageId: createMessageID(200n),
				mentionCount: 0,
			});
			const rollback = service.ackMessage({
				userId: USER_ID,
				channelId: CHANNEL_ID,
				messageId: createMessageID(150n),
				mentionCount: 0,
				manual: true,
			});
			await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
			gate.resolve();
			await expect(first).resolves.toBeDefined();
			await expect(rollback).resolves.toBeDefined();
			expect(rpc).toHaveBeenCalledTimes(2);
			expect(rpc.mock.calls[1]![0].data).toMatchObject({message_id: '150', manual: true});
		} finally {
			Config.readState!.combinedGatewayRpcEnabled = previous;
		}
	});
});
