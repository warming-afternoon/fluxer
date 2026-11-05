// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createGuildID, createRoleID, createUserID} from '@app/api/BrandedTypes';
import {createApiContext} from '@app/api/CreateApiContext';
import {GuildRepository} from '@app/api/guild/repositories/GuildRepository';
import {GuildJoinStateChangedError} from '@app/api/guild/services/member/GuildMemberOperationsService';
import {createGuild} from '@app/api/guild/tests/GuildTestUtils';
import {createRequestCache} from '@app/api/middleware/RequestCacheMiddleware';
import {RequestServices} from '@app/api/middleware/ServiceMiddleware';
import {getGuildRepository} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

describe('native join initialization recovery', () => {
	let harness: ApiTestHarness;
	beforeEach(async () => {
		harness = await createApiTestHarness();
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		await harness.shutdown();
	});

	async function setup() {
		const owner = await createTestAccount(harness);
		const account = await createTestAccount(harness);
		const guild = await createGuild(harness, owner.token, 'Forum');
		const context = createApiContext();
		const requestCache = createRequestCache();
		const services = new RequestServices(context, null, requestCache);
		const guildId = createGuildID(BigInt(guild.id));
		const userId = createUserID(BigInt(account.userId));
		const params = {
			guildId,
			userId,
			requestCache,
			sendJoinMessage: false,
			recovery: {joinedAt: new Date(), lastLeftAt: null},
		};
		return {context, services, params, repository: getGuildRepository(), account};
	}

	it('repairs a member committed before its reverse index without overwriting changed member data', async () => {
		const {services, params, repository, context} = await setup();
		vi.spyOn(GuildRepository.prototype, 'ensureMemberUserIndex').mockRejectedValueOnce(new Error('index interruption'));
		await expect(services.guildService.members.addUserToGuild(params)).rejects.toThrow('index interruption');
		const member = (await repository.getMember(params.guildId, params.userId))!;
		await repository.upsertMember({
			...member.toRow(),
			nick: 'Custom',
			role_ids: new Set([createRoleID(123n)]),
			communication_disabled_until: new Date(Date.now() + 60_000),
		});
		const recovered = await services.guildService.members.addUserToGuild(params);
		expect(recovered.nickname).toBe('Custom');
		expect(recovered.roleIds.has(createRoleID(123n))).toBe(true);
		expect(recovered.communicationDisabledUntil).not.toBeNull();
		expect(await context.services.users.getUserGuildIds(params.userId)).toContain(params.guildId);
		expect((await repository.findUnique(params.guildId))!.memberCount).toBe(2);
	});

	it('replays gateway initialization after interruption without incrementing the member count twice', async () => {
		const {services, params, repository, context} = await setup();
		const join = vi
			.spyOn(context.services.gateway, 'joinGuild')
			.mockRejectedValueOnce(new Error('gateway interruption'));
		await expect(services.guildService.members.addUserToGuild(params)).rejects.toThrow('gateway interruption');
		await services.guildService.members.addUserToGuild(params);
		expect(join).toHaveBeenCalledTimes(2);
		expect((await repository.findUnique(params.guildId))!.memberCount).toBe(2);
	});

	it('does not recreate a membership removed by a kick during interrupted initialization', async () => {
		const {services, params, repository, context} = await setup();
		vi.spyOn(context.services.gateway, 'joinGuild').mockRejectedValueOnce(new Error('gateway interruption'));
		await expect(services.guildService.members.addUserToGuild(params)).rejects.toThrow();
		await services.guildService.members.removeMemberAsSystem({guildId: params.guildId, targetId: params.userId});
		await expect(services.guildService.members.addUserToGuild(params)).rejects.toBeInstanceOf(
			GuildJoinStateChangedError,
		);
		expect(await repository.getMember(params.guildId, params.userId)).toBeNull();
	});

	it('checks a current ban before repairing an existing partially initialized member', async () => {
		const {services, params, repository, context} = await setup();
		vi.spyOn(context.services.gateway, 'joinGuild').mockRejectedValueOnce(new Error('gateway interruption'));
		await expect(services.guildService.members.addUserToGuild(params)).rejects.toThrow();
		await repository.upsertBan({
			guild_id: params.guildId,
			user_id: params.userId,
			moderator_id: params.userId,
			banned_at: new Date(),
			expires_at: null,
			reason: 'Ban',
			ip: null,
			email: null,
		});
		const dispatch = vi.spyOn(context.services.gateway, 'dispatchGuild');
		await expect(services.guildService.members.addUserToGuild(params)).rejects.toMatchObject({
			code: 'USER_BANNED_FROM_GUILD',
		});
		expect(dispatch).not.toHaveBeenCalled();
	});

	it('serializes concurrent initialization and leaves a single authoritative membership', async () => {
		const {services, params, repository} = await setup();
		const results = await Promise.allSettled([
			services.guildService.members.addUserToGuild(params),
			services.guildService.members.addUserToGuild(params),
		]);
		expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
		await services.guildService.members.addUserToGuild(params);
		expect((await repository.findUnique(params.guildId))!.memberCount).toBe(2);
		expect(await repository.countMembers(params.guildId)).toBe(2);
	});

	it('does not write a member after losing the membership lease', async () => {
		const {services, params, repository, context} = await setup();
		vi.spyOn(context.services.cache, 'extendLock').mockResolvedValueOnce(false);
		await expect(services.guildService.members.addUserToGuild(params)).rejects.toMatchObject({status: 423});
		expect(await repository.getMember(params.guildId, params.userId)).toBeNull();
	});

	it.each(['skipBanCheck', 'skipAccountLimitCheck', 'skipGuildLimitCheck'] as const)(
		'refuses to bypass native restrictions in recovery through %s',
		async (flag) => {
			const {services, params, repository} = await setup();
			await expect(services.guildService.members.addUserToGuild({...params, [flag]: true})).rejects.toBeInstanceOf(
				GuildJoinStateChangedError,
			);
			expect(await repository.getMember(params.guildId, params.userId)).toBeNull();
		},
	);

	it('refuses an old recovery after leave metadata could have expired', async () => {
		const {services, params, repository} = await setup();
		params.recovery.joinedAt = new Date(Date.now() - 366 * 24 * 60 * 60 * 1000);
		await expect(services.guildService.members.addUserToGuild(params)).rejects.toBeInstanceOf(
			GuildJoinStateChangedError,
		);
		expect(await repository.getMember(params.guildId, params.userId)).toBeNull();
	});

	it('recovers the count when its lease was lost after conditional member creation', async () => {
		const {services, params, repository, context} = await setup();
		vi.spyOn(context.services.cache, 'extendLock').mockResolvedValueOnce(true).mockResolvedValueOnce(false);
		await expect(services.guildService.members.addUserToGuild(params)).rejects.toMatchObject({status: 423});
		expect(await repository.getMember(params.guildId, params.userId)).not.toBeNull();
		expect((await repository.findUnique(params.guildId))!.memberCount).toBe(1);
		await services.guildService.members.addUserToGuild(params);
		expect((await repository.findUnique(params.guildId))!.memberCount).toBe(2);
	});

	it('preserves an explicit guild hide-muted setting while resuming initialization', async () => {
		const {services, params, context} = await setup();
		const settings = (await context.services.users.findSettings(params.userId))!;
		await context.services.users.upsertSettings({...settings.toRow(), default_hide_muted_channels: true});
		vi.spyOn(context.services.gateway, 'joinGuild').mockRejectedValueOnce(new Error('gateway interruption'));
		await expect(services.guildService.members.addUserToGuild(params)).rejects.toThrow();
		const guildSettings = (await context.services.users.findGuildSettings(params.userId, params.guildId))!;
		await context.services.users.upsertGuildSettings({...guildSettings.toRow(), hide_muted_channels: false});
		await services.guildService.members.addUserToGuild(params);
		expect((await context.services.users.findGuildSettings(params.userId, params.guildId))!.hideMutedChannels).toBe(
			false,
		);
	});

	it('serializes a concurrent moderator ban after join and never undoes that ban on retry', async () => {
		const {services, params, repository, context} = await setup();
		let release!: () => void;
		let observed!: () => void;
		const reachedGateway = new Promise<void>((resolve) => {
			observed = resolve;
		});
		vi.spyOn(context.services.gateway, 'joinGuild').mockImplementationOnce(async () => {
			observed();
			await new Promise<void>((resolve) => {
				release = resolve;
			});
		});
		const joining = services.guildService.members.addUserToGuild(params);
		await reachedGateway;
		const banning = services.guildService.moderation.banMemberAsSystem({
			guildId: params.guildId,
			targetId: params.userId,
		});
		release();
		await Promise.all([joining, banning]);
		expect(await repository.getMember(params.guildId, params.userId)).toBeNull();
		await expect(services.guildService.members.addUserToGuild(params)).rejects.toMatchObject({
			code: 'USER_BANNED_FROM_GUILD',
		});
	});
});
