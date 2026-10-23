// SPDX-License-Identifier: AGPL-3.0-or-later

import {createChannelID, createGuildID, createUserID} from '@app/api/BrandedTypes';
import {getConfig} from '@app/api/Config';
import type {ChannelRepository} from '@app/api/channel/ChannelRepository';
import {ChannelAuthService} from '@app/api/channel/services/channel_data/ChannelAuthService';
import {SYSTEM_THREAD_VIEWER} from '@app/api/experiment/ChannelThreadsGate';
import type {GuildRepository} from '@app/api/guild/repositories/GuildRepository';
import type {IGatewayService} from '@app/api/infrastructure/IGatewayService';
import type {UserRepository} from '@app/api/user/repositories/UserRepository';
import * as AgeUtils from '@app/api/utils/AgeUtils';
import {ChannelTypes, Permissions} from '@fluxer/constants/src/ChannelConstants';
import {afterEach, describe, expect, it, vi} from 'vitest';

const guildId = createGuildID(1n),
	userId = createUserID(2n),
	channelId = createChannelID(3n),
	parentId = createChannelID(4n);
afterEach(() => {
	getConfig().combinedChannelAuthEnabled = false;
	vi.restoreAllMocks();
});
/** 组合成员、权限和帖子状态的鉴权测试依赖。 */
function setup({
	thread = false,
	member = true,
	memberInThread = true,
	permissions = Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES,
	mfa = 0,
	nsfw = false,
	timeout = false,
}: {
	thread?: boolean;
	member?: boolean;
	memberInThread?: boolean;
	permissions?: bigint;
	mfa?: number;
	nsfw?: boolean;
	timeout?: boolean;
} = {}) {
	const calls: Array<string> = [];
	const channel = {
		id: channelId,
		guildId,
		parentId: thread ? parentId : null,
		type: thread ? ChannelTypes.PRIVATE_THREAD : ChannelTypes.GUILD_TEXT,
		ownerId: createUserID(9n),
		nsfwOverride: nsfw,
		contentWarningLevel: 0,
		contentWarningText: null,
	};
	const parent = {...channel, id: parentId, parentId: null, type: ChannelTypes.GUILD_TEXT};
	const context = {guild: {id: '1', owner_id: '9', mfa_level: mfa, nsfw: false}, parentChannel: null};
	const memberResult = member
		? {
				success: true,
				memberData: {
					user: {id: '2'},
					mute: true,
					communication_disabled_until: timeout ? '2099-01-01T00:00:00.000Z' : null,
				},
			}
		: {success: false};
	const gateway = {
		getGuildAuthContext: async () => {
			calls.push('context');
			return context;
		},
		getGuildMember: async () => {
			calls.push('member');
			return memberResult;
		},
		getUserPermissions: async () => {
			calls.push('permissions');
			return permissions;
		},
		getGuildChannelAuthorization: async () => {
			calls.push('combined');
			return {...context, memberResult, permissions};
		},
	};
	const repository = {
		channelData: {findUnique: async (id: bigint) => (id === channelId ? channel : parent)},
		threads: {
			getState: async () => ({type: ChannelTypes.PRIVATE_THREAD, archived: false, locked: false, invitable: true}),
			getMember: async () => (memberInThread ? {} : null),
		},
	};
	const users = {findUnique: async () => ({authenticatorTypes: new Set()})};
	return {
		calls,
		repository,
		gateway,
		parent,
		service: new ChannelAuthService(
			repository as unknown as ChannelRepository,
			users as unknown as UserRepository,
			{} as GuildRepository,
			gateway as unknown as IGatewayService,
		),
	};
}
const authenticate = (service: ChannelAuthService) =>
	service.getChannelAuthenticated({userId, channelId, viewer: SYSTEM_THREAD_VIEWER});
describe('combined channel auth retained security', () => {
	it('defaults off and changes three guild RPCs to one when enabled', async () => {
		getConfig().combinedChannelAuthEnabled = false;
		const old = setup();
		await authenticate(old.service);
		expect(old.calls).toEqual(['context', 'member', 'permissions']);
		getConfig().combinedChannelAuthEnabled = true;
		const next = setup();
		await authenticate(next.service);
		expect(next.calls).toEqual(['combined']);
	});
	it.each([false, true])('rejects nonmember with flag=%s', async (enabled) => {
		getConfig().combinedChannelAuthEnabled = enabled;
		await expect(authenticate(setup({member: false}).service)).rejects.toThrow();
	});
	it.each([false, true])('keeps private-thread membership checks with flag=%s', async (enabled) => {
		getConfig().combinedChannelAuthEnabled = enabled;
		await expect(authenticate(setup({thread: true, memberInThread: false}).service)).rejects.toThrow();
		const auth = await authenticate(setup({thread: true}).service);
		expect(auth.thread?.parent.id).toBe(parentId);
	});
	it.each([false, true])('retains timeout and mute request snapshot with flag=%s', async (enabled) => {
		getConfig().combinedChannelAuthEnabled = enabled;
		const auth = await authenticate(setup({timeout: true}).service);
		expect(auth.member).toMatchObject({mute: true, communication_disabled_until: '2099-01-01T00:00:00.000Z'});
	});
	it.each([false, true])('denies missing VIEW_CHANNEL with flag=%s', async (enabled) => {
		getConfig().combinedChannelAuthEnabled = enabled;
		await expect(authenticate(setup({permissions: 0n}).service)).rejects.toThrow();
	});
	it.each([false, true])(
		'still enforces elevated guild MFA for allowed admin/moderation action with flag=%s',
		async (enabled) => {
			getConfig().combinedChannelAuthEnabled = enabled;
			const auth = await authenticate(
				setup({mfa: 1, permissions: Permissions.VIEW_CHANNEL | Permissions.ADMINISTRATOR | Permissions.MANAGE_MESSAGES})
					.service,
			);
			await expect(auth.checkPermission(Permissions.MANAGE_MESSAGES)).rejects.toThrow();
		},
	);
	it.each([false, true])('still enforces NSFW age validation with flag=%s', async (enabled) => {
		getConfig().combinedChannelAuthEnabled = enabled;
		const age = vi.spyOn(AgeUtils, 'canUserAccessNsfwContent').mockReturnValue(false);
		await expect(authenticate(setup({nsfw: true}).service)).rejects.toThrow();
		expect(age).toHaveBeenCalledOnce();
	});
});

/** 建立可控制完成顺序的异步测试结果。 */
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return {promise, resolve, reject};
}

describe('combined thread authorization overlap', () => {
	it('starts authorization after valid parent, before independent reads finish', async () => {
		getConfig().combinedChannelAuthEnabled = true;
		const fixture = setup({thread: true});
		const parent = deferred<typeof fixture.parent>();
		const state = deferred<Awaited<ReturnType<typeof fixture.repository.threads.getState>>>();
		const member = deferred<{} | null>();
		vi.spyOn(fixture.repository.channelData, 'findUnique').mockReturnValue(parent.promise);
		vi.spyOn(fixture.repository.threads, 'getState').mockReturnValue(state.promise);
		vi.spyOn(fixture.repository.threads, 'getMember').mockReturnValue(member.promise);
		const started = deferred<void>();
		const original = fixture.gateway.getGuildChannelAuthorization;
		vi.spyOn(fixture.gateway, 'getGuildChannelAuthorization').mockImplementation(async () => {
			started.resolve();
			return original();
		});
		const result = fixture.service.resolveThreadPermissionContext({
			thread: {...fixture.parent, id: channelId, parentId} as never,
			userId,
		});
		expect(fixture.calls).toEqual([]);
		parent.resolve(fixture.parent);
		await started.promise;
		expect(fixture.calls).toEqual(['combined']);
		state.resolve({type: ChannelTypes.PRIVATE_THREAD, archived: false, locked: false, invitable: true});
		member.resolve({});
		await expect(result).resolves.toMatchObject({thread: {parent: {id: parentId}}});
	});
	it('never starts authorization for an invalid parent', async () => {
		getConfig().combinedChannelAuthEnabled = true;
		const fixture = setup({thread: true});
		vi.spyOn(fixture.repository.channelData, 'findUnique').mockResolvedValue(null as never);
		await expect(
			fixture.service.resolveThreadPermissionContext({thread: {...fixture.parent, parentId} as never, userId}),
		).rejects.toThrow('UNKNOWN_CHANNEL');
		expect(fixture.calls).toEqual([]);
	});
	it('keeps missing state ahead of an early authorization rejection', async () => {
		getConfig().combinedChannelAuthEnabled = true;
		const fixture = setup({thread: true});
		vi.spyOn(fixture.repository.threads, 'getState').mockResolvedValue(null as never);
		vi.spyOn(fixture.gateway, 'getGuildChannelAuthorization').mockRejectedValue(new Error('authorization failed'));
		await expect(
			fixture.service.resolveThreadPermissionContext({thread: {...fixture.parent, parentId} as never, userId}),
		).rejects.toThrow('UNKNOWN_CHANNEL');
	});
	it('observes an early authorization failure while waiting for independent reads', async () => {
		getConfig().combinedChannelAuthEnabled = true;
		const fixture = setup({thread: true});
		const state = deferred<Awaited<ReturnType<typeof fixture.repository.threads.getState>>>();
		const started = deferred<void>();
		vi.spyOn(fixture.repository.threads, 'getState').mockReturnValue(state.promise);
		vi.spyOn(fixture.gateway, 'getGuildChannelAuthorization').mockImplementation(async () => {
			started.resolve();
			throw new Error('authorization failed');
		});
		const result = fixture.service.resolveThreadPermissionContext({
			thread: {...fixture.parent, parentId} as never,
			userId,
		});
		let settled = false;
		const checked = expect(result)
			.rejects.toThrow('authorization failed')
			.finally(() => {
				settled = true;
			});
		await started.promise;
		await Promise.resolve();
		await Promise.resolve();
		expect(settled).toBe(false);
		state.resolve({type: ChannelTypes.PRIVATE_THREAD, archived: false, locked: false, invitable: true});
		await checked;
	});
	it('drains in-flight authorization and preserves the repository rejection', async () => {
		getConfig().combinedChannelAuthEnabled = true;
		const fixture = setup({thread: true}),
			auth = deferred<Awaited<ReturnType<typeof fixture.gateway.getGuildChannelAuthorization>>>();
		const state = deferred<Awaited<ReturnType<typeof fixture.repository.threads.getState>>>(),
			started = deferred<void>();
		vi.spyOn(fixture.repository.threads, 'getState').mockReturnValue(state.promise);
		vi.spyOn(fixture.gateway, 'getGuildChannelAuthorization').mockImplementation(() => {
			started.resolve();
			return auth.promise;
		});
		const result = fixture.service.resolveThreadPermissionContext({
			thread: {...fixture.parent, parentId} as never,
			userId,
		});
		let settled = false;
		const checked = expect(result)
			.rejects.toThrow('repository failed')
			.finally(() => {
				settled = true;
			});
		await started.promise;
		state.reject(new Error('repository failed'));
		await Promise.resolve();
		await Promise.resolve();
		expect(settled).toBe(false);
		auth.reject(new Error('authorization failed'));
		await checked;
	});
	it('propagates authorization failure only after successful independent reads, without fallback', async () => {
		getConfig().combinedChannelAuthEnabled = true;
		const fixture = setup({thread: true});
		vi.spyOn(fixture.gateway, 'getGuildChannelAuthorization').mockRejectedValue(new Error('authorization failed'));
		await expect(
			fixture.service.resolveThreadPermissionContext({thread: {...fixture.parent, parentId} as never, userId}),
		).rejects.toThrow('authorization failed');
		expect(fixture.calls).toEqual([]);
	});
	it('does not start late authorization after a repository failure', async () => {
		getConfig().combinedChannelAuthEnabled = true;
		const fixture = setup({thread: true}),
			parent = deferred<typeof fixture.parent>();
		vi.spyOn(fixture.repository.channelData, 'findUnique').mockReturnValue(parent.promise);
		vi.spyOn(fixture.repository.threads, 'getState').mockRejectedValue(new Error('state failed'));
		const result = fixture.service.resolveThreadPermissionContext({
			thread: {...fixture.parent, parentId} as never,
			userId,
		});
		const checked = expect(result).rejects.toThrow('state failed');
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		parent.resolve(fixture.parent);
		await checked;
		expect(fixture.calls).toEqual([]);
	});
	it.each(['parent', 'state', 'member'] as const)('preserves first repository rejection from %s', async (first) => {
		getConfig().combinedChannelAuthEnabled = true;
		const fixture = setup({thread: true}),
			parent = deferred<typeof fixture.parent>();
		const state = deferred<Awaited<ReturnType<typeof fixture.repository.threads.getState>>>(),
			member = deferred<{} | null>();
		vi.spyOn(fixture.repository.channelData, 'findUnique').mockReturnValue(parent.promise);
		vi.spyOn(fixture.repository.threads, 'getState').mockReturnValue(state.promise);
		vi.spyOn(fixture.repository.threads, 'getMember').mockReturnValue(member.promise);
		const result = fixture.service.resolveThreadPermissionContext({
			thread: {...fixture.parent, parentId} as never,
			userId,
		});
		const checked = expect(result).rejects.toThrow(first + ' failed');
		const failures = {parent, state, member};
		failures[first].reject(new Error(first + ' failed'));
		await Promise.resolve();
		await Promise.resolve();
		for (const [name, pending] of Object.entries(failures))
			if (name !== first) pending.reject(new Error(name + ' failed'));
		await checked;
		expect(fixture.calls).toEqual([]);
	});
});
