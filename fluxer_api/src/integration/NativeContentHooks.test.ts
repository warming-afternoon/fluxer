// SPDX-License-Identifier: AGPL-3.0-or-later

import {createChannelID, createMessageID, createUserID} from '@app/api/BrandedTypes';
import type {ChannelDataRepository} from '@app/api/channel/repositories/ChannelDataRepository';
import {MessageInteractionRepository} from '@app/api/channel/repositories/MessageInteractionRepository';
import {MessageRepository} from '@app/api/channel/repositories/MessageRepository';
import {MessageDataRepository} from '@app/api/channel/repositories/message/MessageDataRepository';
import {MessageDeletionRepository} from '@app/api/channel/repositories/message/MessageDeletionRepository';
import * as Execution from '@app/api/database/CassandraQueryExecution';
import type {MessageRow} from '@app/api/database/types/MessageTypes';
import type {Message} from '@app/api/models/Message';
import * as Hooks from '@app/integration/IntegrationContentHooks';
import {afterEach, describe, expect, it, vi} from 'vitest';

describe('native mutation journal hooks', () => {
	afterEach(() => vi.restoreAllMocks());
	it('persists intent before a native message write and observes its committed content afterward', async () => {
		const order: Array<string> = [];
		vi.spyOn(Hooks, 'prepareIntegrationContentChange').mockImplementation(async () => {
			order.push('intent');
		});
		vi.spyOn(Hooks, 'finishIntegrationContentChange').mockImplementation(async () => {
			order.push('snapshot');
		});
		vi.spyOn(MessageDataRepository.prototype, 'upsertMessage').mockImplementation(async () => {
			order.push('native-write');
			return {} as Message;
		});
		const row = {channel_id: createChannelID(11n), message_id: createMessageID(22n)} as MessageRow;
		await new MessageRepository({} as ChannelDataRepository).upsertMessage(row, row);
		expect(order).toEqual(['intent', 'native-write', 'snapshot']);
	});
	it('marks an actual native starter deletion explicitly instead of translating a lookup 404 into deletion', async () => {
		const prepare = vi.spyOn(Hooks, 'prepareIntegrationContentChange').mockResolvedValue();
		vi.spyOn(Hooks, 'finishIntegrationContentChange').mockResolvedValue();
		vi.spyOn(MessageDeletionRepository.prototype, 'deleteMessage').mockResolvedValue();
		await new MessageRepository({} as ChannelDataRepository).deleteMessage(
			createChannelID(11n),
			createMessageID(11n),
			createUserID(33n),
		);
		expect(prepare).toHaveBeenCalledWith(createChannelID(11n), undefined, true);
	});
	it('journals native reaction mutations rather than only integration RPC calls', async () => {
		const prepare = vi.spyOn(Hooks, 'prepareIntegrationContentChange').mockResolvedValue();
		const finish = vi.spyOn(Hooks, 'finishIntegrationContentChange').mockResolvedValue();
		vi.spyOn(Execution, 'upsertOne').mockResolvedValue();
		const repository = new MessageInteractionRepository({} as MessageRepository);
		vi.spyOn(repository, 'setHasReaction').mockResolvedValue();
		await repository.addReaction(createChannelID(11n), createMessageID(11n), createUserID(33n), '👍');
		expect(prepare).toHaveBeenCalledWith(createChannelID(11n));
		expect(finish).toHaveBeenCalledWith(createChannelID(11n));
	});
});
