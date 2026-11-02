// SPDX-License-Identifier: AGPL-3.0-or-later

import {MessageEditService} from '@app/api/channel/services/message/MessageEditService';
import {withIntegrationStarterEditScope} from '@app/integration/IntegrationStarterEditContext';
import {UserFlags} from '@fluxer/constants/src/UserConstants';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@app/api/Config', () => ({Config: {instance: {selfHosted: false}}}));
vi.mock('@app/api/channel/services/message/MessageActivity', () => ({emitMessageUpdated: vi.fn()}));
vi.mock('@app/api/channel/services/message/MessageGatewayDispatch', () => ({dispatchMessageUpdateBroadcast: vi.fn()}));
vi.mock('@app/api/channel/services/message/MessageHelpers', () => ({isOperationDisabled: () => false}));
vi.mock('@app/api/channel/services/PersonalNotesChannelRepair', () => ({isPersonalNotesChannelId: () => false}));
vi.mock('@app/api/user/NewConversationLimit', () => ({
	assertMayStartConversation: vi.fn(),
	oneToOneDmRecipient: () => null,
}));
vi.mock('@app/api/channel/services/thread/ThreadPolicyService', () => ({
	ThreadPolicyService: class {
		async assertAllowed() {}
	},
}));
vi.mock('@app/integration/IntegrationIdentityRepository', () => ({
	IntegrationIdentityRepository: class {
		async canonicalUserId() {
			return 202n;
		}
	},
}));
vi.mock('@app/integration/IntegrationOperationRepository', () => ({
	IntegrationOperationRepository: class {
		async allocate(row: unknown) {
			return row;
		}
	},
}));

function fixture({timedOut = false, archived = false} = {}) {
	const validation = vi.fn(() => {
		throw Error('AFTER_NATIVE_GUARDS');
	});
	const user = {traits: new Set(['discord_integration']), flags: UserFlags.DISABLED};
	const message = {id: 303n, channelId: 303n, authorId: 101n, content: 'before', attachments: []};
	const auth = {
		channel: {id: 303n, guildId: 1n},
		guild: {},
		hasPermission: async () => true,
		member: {communication_disabled_until: timedOut ? new Date(Date.now() + 60_000).toISOString() : null},
		thread: {
			state: {hasStarter: true},
			parent: {id: 10n, isThreadOnly: () => true},
			actor: {
				timedOut,
				permissions: 0n,
				isOwner: false,
				isThreadOwner: false,
				isMember: true,
				thread: {type: 11, archived, locked: false},
			},
		},
	};
	const service = new MessageEditService({
		channelAuthService: {getChannelAuthenticated: async () => auth},
		channelRepository: {messages: {getMessage: async () => message}},
		userRepository: {findUnique: async () => user},
		validationService: {validateMessageEditable: validation},
	} as unknown as ConstructorParameters<typeof MessageEditService>[0]);
	const call = () =>
		withIntegrationStarterEditScope({actorUserId: '202', guildId: '1', threadId: '303'}, () =>
			service.editMessage({
				userId: 202n,
				channelId: 303n,
				messageId: 303n,
				data: {content: 'after'},
				requestCache: {},
				viewer: {},
			} as never),
		);
	return {call, validation};
}
describe('delegated native starter guards', () => {
	beforeEach(() => {
		vi.stubEnv('FLUXER_THREAD_POLICY_ENABLED', 'true');
		vi.stubEnv('INTEGRATION_GUILD_ID', '1');
		vi.stubEnv('INTEGRATION_FORUM_CHANNEL_IDS', '10,11,12,13');
	});
	afterEach(() => vi.unstubAllEnvs());
	it('enforces the actual B guild timeout when editing merged C content', async () => {
		const {call, validation} = fixture({timedOut: true});
		await expect(call()).rejects.toMatchObject({code: 'COMMUNICATION_DISABLED'});
		expect(validation).not.toHaveBeenCalled();
	});
	it('keeps archived thread protection before delegated body validation', async () => {
		const {call, validation} = fixture({archived: true});
		await expect(call()).rejects.toMatchObject({code: 'THREAD_ARCHIVED'});
		expect(validation).not.toHaveBeenCalled();
	});
	it('continues through native guards for an eligible unarchived delegated edit', async () => {
		const {call, validation} = fixture();
		await expect(call()).rejects.toThrow('AFTER_NATIVE_GUARDS');
		expect(validation).toHaveBeenCalledOnce();
	});
});
