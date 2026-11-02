// SPDX-License-Identifier: AGPL-3.0-or-later

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.hoisted(() => {
	vi.resetModules();
});
const source = vi.hoisted(() => ({
	state: vi.fn(),
	channel: vi.fn(),
	message: vi.fn(),
	reactions: vi.fn(),
	stats: vi.fn(),
	snapshot: vi.fn(),
	intent: vi.fn(),
	track: vi.fn(),
	creation: vi.fn(),
	failCreation: vi.fn(),
	parentConfig: vi.fn(),
}));
vi.mock('@app/api/channel/ChannelRepository', () => ({
	ChannelRepository: class {
		threads = {getState: source.state, getStats: source.stats, getParentConfig: source.parentConfig};
		channelData = {findUnique: source.channel};
		messages = {getMessage: source.message};
		messageInteractions = {listMessageReactions: source.reactions};
	},
}));
vi.mock('@app/api/middleware/ServiceSingletons', () => ({
	getCacheService: () => ({acquireLock: async () => 'lease', extendLock: async () => true, releaseLock: vi.fn()}),
}));
vi.mock('@app/api/attachment/AttachmentUrls', () => ({
	makeSignedAttachmentCdnUrl: () => 'https://media.example/first.png?signature=valid',
}));
vi.mock('@app/api/Logger', () => ({Logger: {warn: vi.fn()}}));
vi.mock('@app/integration/IntegrationEventJournal', () => ({
	IntegrationEventJournal: class {
		snapshot = source.snapshot;
		resource = source.intent;
		track = source.track;
		failCreation = source.failCreation;
	},
}));
vi.mock('@app/integration/IntegrationCreationEventGate', () => ({
	IntegrationCreationEventGate: class {
		status = source.creation;
	},
}));

import {projectIntegrationContent} from '@app/integration/IntegrationContentEvents';

describe('authoritative native content snapshots', () => {
	beforeEach(() => {
		vi.resetAllMocks();
		vi.stubEnv('INTEGRATION_NATS_URL', 'nats://test');
		vi.stubEnv('INTEGRATION_GUILD_ID', '1');
		vi.stubEnv('INTEGRATION_FORUM_CHANNEL_IDS', '22,23,24,25');
		source.state.mockResolvedValue({
			guildId: 1n,
			parentId: 22n,
			hasStarter: true,
			archived: false,
			locked: false,
			createdAt: new Date('2020-01-02T03:04:05Z'),
		});
		source.channel.mockResolvedValue({name: '原生作品', ownerId: 11n});
		source.message.mockResolvedValue({content: '原生正文', authorId: 11n, attachments: []});
		source.stats.mockResolvedValue({messageCount: 4});
		source.reactions.mockResolvedValue([]);
		source.intent.mockResolvedValue({creation_operation_id: 'task-7'});
		source.creation.mockResolvedValue('ready');
		source.parentConfig.mockResolvedValue({availableTags: []});
	});
	afterEach(() => vi.unstubAllEnvs());
	it('aggregates each emoji from authoritative reaction rows and retains durable creation correlation', async () => {
		source.reactions.mockResolvedValue([
			{emojiId: 0n, emojiName: '👍', isEmojiAnimated: false},
			{emojiId: 0n, emojiName: '👍', isEmojiAnimated: false},
			{emojiId: 7n, emojiName: 'party', isEmojiAnimated: true},
		]);
		await projectIntegrationContent({guild_id: '1', channel_id: '22', thread_id: '33'});
		expect(source.snapshot).toHaveBeenCalledWith(
			'thread:33',
			'events.content.v1.thread.changed',
			expect.objectContaining({
				creation_operation_id: 'task-7',
				snapshot: expect.objectContaining({
					created_at: '2020-01-02T03:04:05.000Z',
					body: '原生正文',
					reply_count: 3,
					reactions: [
						{emoji: {id: null, name: '👍', animated: false}, count: 2},
						{emoji: {id: '7', name: 'party', animated: true}, count: 1},
					],
				}),
			}),
		);
	});
	it('does not convert a missing resource or failed authority read into a deletion event', async () => {
		source.state.mockResolvedValue(null);
		await projectIntegrationContent({guild_id: '1', channel_id: '22', thread_id: '33'});
		expect(source.snapshot).not.toHaveBeenCalled();
		source.state.mockRejectedValue(new Error('authority offline'));
		await expect(projectIntegrationContent({guild_id: '1', channel_id: '22', thread_id: '33'})).rejects.toThrow(
			'authority offline',
		);
		expect(source.snapshot).not.toHaveBeenCalled();
	});
	it('emits deletion only when a persisted native deletion intent and authoritative absence agree', async () => {
		source.intent.mockResolvedValue({deleting: true});
		source.state.mockResolvedValue(null);
		await projectIntegrationContent({guild_id: '1', channel_id: '22', thread_id: '33'});
		expect(source.snapshot).toHaveBeenCalledWith(
			'thread:33',
			'events.content.v1.thread.deleted',
			expect.objectContaining({thread_id: '33'}),
		);
	});
	it('keeps create rollback and the same prepared-ID retry invisible until the operation commits', async () => {
		const resource = {guild_id: '1', channel_id: '22', thread_id: '33'};
		source.creation.mockResolvedValue('pending');
		await projectIntegrationContent(resource);
		source.intent.mockResolvedValue({creation_operation_id: 'task-7', deleting: true});
		source.state.mockResolvedValue(null);
		await projectIntegrationContent(resource);
		expect(source.snapshot).not.toHaveBeenCalled();
		source.state.mockResolvedValue({guildId: 1n, parentId: 22n, hasStarter: true, archived: false, locked: false});
		source.creation.mockResolvedValue('ready');
		await projectIntegrationContent(resource);
		expect(source.snapshot).toHaveBeenCalledExactlyOnceWith(
			'thread:33',
			'events.content.v1.thread.changed',
			expect.objectContaining({creation_operation_id: 'task-7', creation_completed: true}),
		);
	});
	it('cleans up terminal creation failures and does not block an uncorrelated native creation', async () => {
		source.creation.mockResolvedValue('failed');
		await projectIntegrationContent({guild_id: '1', channel_id: '22', thread_id: '33'});
		expect(source.failCreation).toHaveBeenCalledWith('thread:33', 'task-7');
		expect(source.snapshot).not.toHaveBeenCalled();
		source.intent.mockResolvedValue(null);
		source.creation.mockClear();
		await projectIntegrationContent({guild_id: '1', channel_id: '22', thread_id: '44'});
		expect(source.creation).not.toHaveBeenCalled();
		expect(source.snapshot).toHaveBeenCalledWith(
			'thread:44',
			'events.content.v1.thread.changed',
			expect.objectContaining({creation_operation_id: null}),
		);
	});
	it('projects native applied-tag additions and removals into distinct complete snapshots', async () => {
		source.parentConfig.mockResolvedValue({
			availableTags: [{id: 7n, name: '冒险', moderated: false, emojiId: null, emojiName: null}],
		});
		source.state.mockResolvedValue({
			guildId: 1n,
			parentId: 22n,
			hasStarter: true,
			archived: false,
			locked: false,
			appliedTags: [7n],
		});
		await projectIntegrationContent({guild_id: '1', channel_id: '22', thread_id: '33'});
		expect(source.snapshot.mock.calls[0]?.[2].snapshot.tags).toEqual([
			{id: '7', name: '冒险', moderated: false, emoji: {id: null, name: null}},
		]);
		source.state.mockResolvedValue({
			guildId: 1n,
			parentId: 22n,
			hasStarter: true,
			archived: false,
			locked: false,
			appliedTags: [],
		});
		await projectIntegrationContent({guild_id: '1', channel_id: '22', thread_id: '33'});
		expect(source.snapshot.mock.calls[1]?.[2].snapshot.tags).toEqual([]);
	});
	it('distinguishes external effective locks from native moderation to prevent policy echo', async () => {
		source.state.mockResolvedValue({
			guildId: 1n,
			parentId: 22n,
			hasStarter: true,
			locked: true,
			archived: true,
			nativeLocked: false,
			nativeArchived: false,
			externalLocked: true,
		});
		await projectIntegrationContent({guild_id: '1', channel_id: '22', thread_id: '33'});
		expect(source.snapshot.mock.calls[0]?.[2].snapshot).toMatchObject({
			locked: true,
			archived: true,
			native_locked: false,
			native_archived: false,
			external_locked: true,
		});
	});
});
