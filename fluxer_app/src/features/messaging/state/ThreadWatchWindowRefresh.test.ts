// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

import type {MessageId} from '@fluxer/schema/src/branded/WireIds';
import type {Message as WireMessage} from '@fluxer/schema/src/domains/message/MessageResponseSchemas';
import {afterEach, describe, expect, it, vi} from 'vitest';

const {httpGet} = vi.hoisted(() => ({httpGet: vi.fn()}));

vi.mock('@app/features/messaging/commands/MessageCommands', () => ({fetchMessages: vi.fn()}));
vi.mock('@app/features/messaging/utils/EmbeddableCodeLinkContent', () => ({
	extractEmbeddableCodeLinkContent: (content: string) => content,
}));
vi.mock('@app/features/messaging/utils/ReactionUtils', () => ({emojiEquals: (a: unknown, b: unknown) => a === b}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: {localInstanceDomain: 'fluxer.test'}}));
vi.mock('@app/features/auth/state/Authentication', () => ({default: {currentUserId: 'me'}}));
vi.mock('@app/features/channel/state/Channels', () => ({
	default: {getChannel: () => undefined, handleMessageCreate: vi.fn()},
}));
vi.mock('@app/features/gateway/transport/GatewaySessionPool', () => ({
	default: {foregroundConnection: {isReady: false, isConnected: true, connectionEpoch: 1}},
}));
vi.mock('@app/features/guild/state/Guilds', () => ({default: {getGuild: () => undefined}}));
vi.mock('@app/features/member/state/GuildMembers', () => ({default: {getMember: () => undefined}}));
vi.mock('@app/features/navigation/state/SelectedChannel', () => ({default: {currentChannelId: null}}));
vi.mock('@app/features/navigation/state/SelectedGuild', () => ({default: {selectedGuildId: null}}));
vi.mock('@app/features/platform/state/AccountScopedWork', () => ({AccountScopedWork: {registerTransition: vi.fn()}}));
vi.mock('@app/features/relationship/state/Relationships', () => ({default: {isBlocked: () => false}}));
vi.mock('@app/features/ui/state/Dimension', () => ({
	default: {channelPinnedToEnd: vi.fn(() => false), forgetChannelDimensions: vi.fn()},
}));
vi.mock('@app/app/I18n', () => ({default: {}}));
vi.mock('@app/features/accessibility/state/Accessibility', () => ({default: {}}));
vi.mock('@app/features/app/components/alerts/DmActionErrorModal', () => ({showDmActionErrorModal: vi.fn()}));
vi.mock('@app/features/app/components/alerts/FeatureTemporarilyDisabledModal', () => ({
	FeatureTemporarilyDisabledModal: vi.fn(),
}));
vi.mock('@app/features/app/components/alerts/GenericErrorModalCommands', () => ({showGenericErrorModal: vi.fn()}));
vi.mock('@app/features/app/components/dialogs/ConfirmModal', () => ({ConfirmModal: vi.fn()}));
vi.mock('@app/features/app/state/ActiveInstanceProductName', () => ({getActiveInstanceProductName: vi.fn()}));
vi.mock('@app/features/channel/components/MessageActionUtils', () => ({canReportMessage: vi.fn()}));
vi.mock('@app/features/devtools/state/DeveloperOptions', () => ({default: {}}));
vi.mock('@app/features/guild/state/GuildMatureContentAgree', () => ({default: {}}));
vi.mock('@app/features/i18n/utils/CommonMessageDescriptors', () => ({DELETE_MESSAGE_DESCRIPTOR: {}}));
vi.mock('@app/features/messaging/components/alerts/MessageCrosspostLimitModal', () => ({
	MessageCrosspostLimitModal: vi.fn(),
}));
vi.mock('@app/features/messaging/components/alerts/MessageEditTooQuickModal', () => ({
	MessageEditTooQuickModal: vi.fn(),
}));
vi.mock('@app/features/messaging/components/alerts/PublishedMessageEditLimitModal', () => ({
	PublishedMessageEditLimitModal: vi.fn(),
}));
vi.mock('@app/features/messaging/state/MessageEdit', () => ({default: {}}));
vi.mock('@app/features/messaging/state/MessageEditMobile', () => ({default: {}}));
vi.mock('@app/features/messaging/state/MessageQueue', () => ({default: {}}));
vi.mock('@app/features/messaging/state/MessageReferences', () => ({default: {handleMessagesFetchSuccess: vi.fn()}}));
vi.mock('@app/features/messaging/state/MessageReply', () => ({default: {}}));
vi.mock('@app/features/moderation/utils/ReportActionUtils', () => ({openReportMessageModal: vi.fn()}));
vi.mock('@app/features/navigation/commands/NavigationCommands', () => ({}));
vi.mock('@app/features/permissions/state/Permission', () => ({default: {}}));
vi.mock('@app/features/platform/state/AuthSession', () => ({default: {}}));
vi.mock('@app/features/platform/transport/RestTransport', () => ({http: {get: httpGet}}));
vi.mock('@app/features/read_state/commands/ReadStateCommands', () => ({}));
vi.mock('@app/features/read_state/state/ReadStates', () => ({default: {handleLoadMessages: vi.fn()}}));
vi.mock('@app/features/slowmode/commands/SlowmodeCommands', () => ({}));
vi.mock('@app/features/threads/state/ChannelThreads', () => ({default: {}}));
vi.mock('@app/features/threads/state/ThreadGuilds', () => ({default: {anyActive: false}}));
vi.mock('@app/features/ui/commands/ModalCommands', () => ({modal: vi.fn()}));
vi.mock('@app/features/ui/commands/ToastCommands', () => ({}));
vi.mock('@app/features/ui/components/form/FormSwitch', () => ({Switch: vi.fn()}));
vi.mock('@app/features/user/utils/AccountLimitUtils', () => ({
	blockIfAccountLimited: vi.fn(),
	handleAccountLimitedError: vi.fn(),
}));
vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({useLingui: vi.fn()}));
vi.mock('mobx-react-lite', () => ({observer: (component: unknown) => component}));
vi.mock('@app/features/user/state/Users', () => ({
	default: {cacheUsers: vi.fn(), getUser: () => undefined, getCurrentUser: () => undefined},
}));
vi.mock('@app/features/gift/utils/GiftCodeUtils', () => ({findGifts: () => []}));
vi.mock('@app/features/invite/utils/InviteUtils', () => ({findInvites: () => []}));
vi.mock('@app/features/theme/utils/ThemeUtils', () => ({findThemes: () => []}));
vi.mock('@app/features/user/models/User', () => ({
	User: class {
		readonly id: string;
		/** 将用户数据保持为简单值对象，隔离头像和会员界面依赖 */
		constructor(private data: {id: string}) {
			this.id = data.id;
		}
		/** 返回用于消息序列化的原始用户数据 */
		toJSON() {
			return this.data;
		}
	},
}));
vi.mock('@app/features/messaging/state/MessageReactions', () => {
	const reactions = new Map();
	return {
		default: {
			hydrateMessageReactions: (id: string, rows: unknown) => reactions.set(id, rows ?? []),
			replaceMessageReactions: (id: string, rows: unknown) => reactions.set(id, rows ?? []),
			getMessageReactions: (id: string) => reactions.get(id) ?? [],
		},
	};
});

const {default: Messages} = await import('@app/features/messaging/state/MessagingMessages');
const {default: Dimension} = await import('@app/features/ui/state/Dimension');
const {fetchMessages, refreshThreadWatchWindow} = await vi.importActual<
	typeof import('@app/features/messaging/commands/MessageCommands')
>('@app/features/messaging/commands/MessageCommands');

/** 构造真实消息模型可读取的最小服务端消息 */
function message(id: string, content = id, edited_timestamp?: string): WireMessage {
	return {
		id,
		channel_id: '10',
		author: {
			id: '99',
			username: 'reader',
			discriminator: '0001',
			global_name: null,
			avatar: null,
			avatar_color: null,
			flags: 0,
		},
		type: 0,
		flags: 0,
		pinned: false,
		tts: false,
		mention_everyone: false,
		mentions: [],
		mention_roles: [],
		content,
		timestamp: '2026-10-16T00:00:00.000Z',
		edited_timestamp,
	} as WireMessage;
}

/** 控制网络请求完成时机，使翻页与补拉按指定顺序交错 */
function pendingResponse() {
	let resolve!: (response: {body: Array<WireMessage>}) => void;
	// 模拟请求保持等待，直到测试提交对应页面
	const promise = new Promise<{body: Array<WireMessage>}>((complete) => {
		resolve = complete;
	});

	// 保留真实的异步响应路径，避免直接模拟补拉结果
	return {promise, resolve};
}

describe('帖子浏览消息窗口恢复', () => {
	afterEach(() => {
		Messages.handleSessionInvalidated();
		httpGet.mockReset();
		vi.mocked(Dimension.channelPinnedToEnd).mockReturnValue(false);
	});

	it('恢复新增、编辑和删除，并保留请求期间收到的实时变化', () => {
		Messages.handleLoadMessagesSuccess({channelId: '10', messages: [message('2'), message('1')]});
		const refresh = Messages.beginWatchRefresh('10');
		Messages.handleMessageDelete({channelId: '10', id: '2'});
		Messages.handleMessageUpdate({message: message('1', 'live edit', '2026-10-16T01:00:00.000Z')});
		Messages.handleIncomingMessage({channelId: '10', message: message('3', 'new')});
		Messages.completeWatchRefresh('10', refresh, [message('2'), message('1')], false, false, null);
		const result = Messages.getMessages('10');
		expect(result.toArray().map((row) => row.id)).toEqual(['1', '3']);
		expect(result.get('1')?.content).toBe('live edit');
		expect(result.get('2')).toBeUndefined();
		Messages.endWatchRefresh('10', refresh);
	});

	it('即使删除事件到达时尚未加载该消息，旧快照也不能使它复活', () => {
		const refresh = Messages.beginWatchRefresh('10');
		Messages.handleMessageDelete({channelId: '10', id: '2'});
		Messages.completeWatchRefresh('10', refresh, [message('2'), message('1')], false, false, null);
		expect(
			Messages.getMessages('10')
				.toArray()
				.map((row) => row.id),
		).toEqual(['1']);
		Messages.endWatchRefresh('10', refresh);
	});

	it('较新的权威编辑不会被请求期间的旧版本编辑覆盖', () => {
		Messages.handleLoadMessagesSuccess({channelId: '10', messages: [message('1')]});
		const refresh = Messages.beginWatchRefresh('10');
		Messages.handleMessageUpdate({message: message('1', 'older', '2026-10-16T01:00:00.000Z')});
		Messages.completeWatchRefresh(
			'10',
			refresh,
			[message('1', 'newer', '2026-10-16T02:00:00.000Z')],
			false,
			false,
			null,
		);
		expect(Messages.getMessages('10').get('1')?.content).toBe('newer');
		Messages.endWatchRefresh('10', refresh);
	});

	it('旧页面的刷新和结束操作不能覆盖较新窗口的恢复', () => {
		const previous = Messages.beginWatchRefresh('10');
		const current = Messages.beginWatchRefresh('10');
		Messages.endWatchRefresh('10', previous);
		Messages.completeWatchRefresh('10', previous, [message('1', 'stale')], false, false, null);
		Messages.handleMessageDelete({channelId: '10', id: '2'});
		Messages.completeWatchRefresh('10', current, [message('2'), message('3')], false, false, null);
		expect(
			Messages.getMessages('10')
				.toArray()
				.map((row) => row.id),
		).toEqual(['3']);
		Messages.endWatchRefresh('10', current);
	});

	it('刷新阅读窗口不触发新的跳转或把远处新消息拼进旧窗口', () => {
		Messages.handleLoadMessagesSuccess({channelId: '10', messages: [message('2'), message('1')]});
		const before = Messages.getMessages('10');
		const refresh = Messages.beginWatchRefresh('10');
		Messages.handleIncomingMessage({channelId: '10', message: message('3')});
		Messages.completeWatchRefresh('10', refresh, [message('1'), message('2')], true, true, '2');
		const result = Messages.getMessages('10');
		expect(result.jumpTicket).toBe(before.jumpTicket);
		expect(result.toArray().map((row) => row.id)).toEqual(['1', '2']);
		expect(result.hasMoreAfter).toBe(true);
		Messages.endWatchRefresh('10', refresh);
	});

	it('较新的正文快照与并发反应删除可以同时保留', () => {
		Messages.handleLoadMessagesSuccess({channelId: '10', messages: [message('1')]});
		const refresh = Messages.beginWatchRefresh('10');
		Messages.handleRemoveAllReactions({channelId: '10', messageId: '1'});
		const snapshot = {
			...message('1', 'newer', '2026-10-16T02:00:00.000Z'),
			reactions: [{emoji: {name: '👍'}, count: 1}],
		};
		Messages.completeWatchRefresh('10', refresh, [snapshot], false, false, null);
		expect(Messages.getMessages('10').get('1')?.content).toBe('newer');
		expect(Messages.getMessages('10').get('1')?.reactions).toEqual([]);
		Messages.endWatchRefresh('10', refresh);
	});

	it('最新快照返回后的边界外新消息仍留下后续补拉标记', () => {
		Messages.handleLoadMessagesSuccess({channelId: '10', messages: [message('2'), message('1')]});
		const refresh = Messages.beginWatchRefresh('10');
		Messages.handleIncomingMessage({channelId: '10', message: message('3')});
		Messages.completeWatchRefresh('10', refresh, [message('2'), message('1')], false, false, '2');
		const result = Messages.getMessages('10');
		expect(result.toArray().map((row) => row.id)).toEqual(['1', '2']);
		expect(result.hasMoreAfter).toBe(true);
		Messages.handleIncomingMessage({channelId: '10', message: message('4')});
		expect(Messages.getMessages('10').get('4')).toBeUndefined();
		Messages.endWatchRefresh('10', refresh);
	});

	it('已经删除的边界外新消息不制造虚假的后续分页', () => {
		Messages.handleLoadMessagesSuccess({channelId: '10', messages: [message('2'), message('1')]});
		const refresh = Messages.beginWatchRefresh('10');
		Messages.handleIncomingMessage({channelId: '10', message: message('3')});
		Messages.handleMessageDelete({channelId: '10', id: '3'});
		Messages.completeWatchRefresh('10', refresh, [message('2'), message('1')], false, false, '2');
		expect(Messages.getMessages('10').hasMoreAfter).toBe(false);
		Messages.endWatchRefresh('10', refresh);
	});

	it('补拉期间完成的新跳转窗口不能被旧快照覆盖', () => {
		Messages.handleLoadMessagesSuccess({channelId: '10', messages: [message('2'), message('1')]});
		const refresh = Messages.beginWatchRefresh('10');
		Messages.handleLoadMessages({channelId: '10', jump: {messageId: '100' as MessageId}});
		Messages.handleLoadMessagesSuccess({
			channelId: '10',
			messages: [message('101'), message('100')],
			jump: {messageId: '100' as MessageId},
		});
		const jumped = Messages.getMessages('10');
		Messages.completeWatchRefresh('10', refresh, [message('2'), message('1')], false, false, '2');
		expect(Messages.getMessages('10')).toBe(jumped);
		expect(Messages.getMessages('10').get('100')).toBeDefined();
		Messages.endWatchRefresh('10', refresh);
	});

	it('翻页打断补拉后等待翻页完成，重新恢复遗漏的编辑和删除', async () => {
		vi.mocked(Dimension.channelPinnedToEnd).mockReturnValue(true);
		Messages.handleLoadMessagesSuccess({channelId: '10', messages: [message('2'), message('1')]});
		const stale = pendingResponse();
		const page = pendingResponse();
		httpGet
			.mockReturnValueOnce(stale.promise)
			.mockReturnValueOnce(page.promise)
			.mockResolvedValueOnce({body: [message('3'), message('1', 'recovered', '2026-10-16T02:00:00.000Z')]});
		const recovery = refreshThreadWatchWindow('10', () => true);
		await vi.waitFor(() => expect(httpGet).toHaveBeenCalledTimes(1));
		const loadingPage = fetchMessages('10', '1', null, 50);
		await vi.waitFor(() => expect(httpGet).toHaveBeenCalledTimes(2));
		stale.resolve({body: [message('2'), message('1', 'stale')]});
		// 翻页仍在加载时，失效快照既不能写回也不能提前启动重试
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(Messages.getMessages('10').get('1')?.content).toBe('1');
		expect(Messages.getMessages('10').loadingMore).toBe(true);
		expect(httpGet).toHaveBeenCalledTimes(2);
		page.resolve({body: [message('0')]});
		await loadingPage;
		await recovery;
		expect(httpGet).toHaveBeenCalledTimes(3);
		expect(Messages.getMessages('10').get('1')?.content).toBe('recovered');
		expect(Messages.getMessages('10').get('2')).toBeUndefined();
		expect(Messages.getMessages('10').get('3')).toBeDefined();
	});

	it('缓存跳转打断补拉后按新的历史阅读范围恢复，并保留跳转定位', async () => {
		vi.mocked(Dimension.channelPinnedToEnd).mockReturnValue(true);
		Messages.handleLoadMessagesSuccess({channelId: '10', messages: [message('2'), message('1')]});
		const stale = pendingResponse();
		httpGet
			.mockReturnValueOnce(stale.promise)
			.mockResolvedValueOnce({body: [message('3'), message('2'), message('1')]})
			.mockResolvedValueOnce({body: [message('2'), message('1', 'recovered', '2026-10-16T02:00:00.000Z')]});
		const recovery = refreshThreadWatchWindow('10', () => true);
		await vi.waitFor(() => expect(httpGet).toHaveBeenCalledTimes(1));
		vi.mocked(Dimension.channelPinnedToEnd).mockReturnValue(false);
		await fetchMessages('10', null, null, 50, {messageId: '1' as MessageId});
		const jumped = Messages.getMessages('10');
		stale.resolve({body: [message('3')]});
		await recovery;
		const restored = Messages.getMessages('10');
		expect(httpGet).toHaveBeenCalledTimes(3);
		expect(httpGet.mock.calls[2][1].query.before).toBe('3');
		expect(restored.toArray().map((row) => row.id)).toEqual(['1', '2']);
		expect(restored.get('1')?.content).toBe('recovered');
		expect(restored.hasMoreAfter).toBe(true);
		expect(restored.jumpTicket).toBe(jumped.jumpTicket);
		expect(restored.jumpDestinationId).toBe('1');
	});

	it('翻页等待期间关闭帖子，旧补拉不会重试或覆盖窗口', async () => {
		vi.mocked(Dimension.channelPinnedToEnd).mockReturnValue(true);
		Messages.handleLoadMessagesSuccess({channelId: '10', messages: [message('2'), message('1')]});
		const stale = pendingResponse();
		const page = pendingResponse();
		httpGet.mockReturnValueOnce(stale.promise).mockReturnValueOnce(page.promise);
		let current = true;
		const recovery = refreshThreadWatchWindow('10', () => current);
		await vi.waitFor(() => expect(httpGet).toHaveBeenCalledTimes(1));
		const loadingPage = fetchMessages('10', '1', null, 50);
		await vi.waitFor(() => expect(httpGet).toHaveBeenCalledTimes(2));
		stale.resolve({body: [message('2'), message('1', 'stale')]});
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		current = false;
		page.resolve({body: [message('0')]});
		await loadingPage;
		await recovery;
		expect(httpGet).toHaveBeenCalledTimes(2);
		expect(Messages.getMessages('10').get('1')?.content).toBe('1');
	});
});
