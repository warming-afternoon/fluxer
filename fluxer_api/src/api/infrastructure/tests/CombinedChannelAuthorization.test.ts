// SPDX-License-Identifier: AGPL-3.0-or-later

import {createChannelID, createGuildID, createUserID} from '@app/api/BrandedTypes';
import {GatewayRpcClient} from '@app/api/infrastructure/GatewayRpcClient';
import {GatewayRpcMethodError, GatewayRpcMethodErrorCodes} from '@app/api/infrastructure/GatewayRpcError';
import {GatewayService} from '@app/api/infrastructure/GatewayService';
import {GatewayTimeoutError} from '@fluxer/errors/src/domains/core/GatewayTimeoutError';
import {afterEach, describe, expect, it} from 'vitest';

const params = {
	guildId: createGuildID(1n),
	userId: createUserID(2n),
	channelId: createChannelID(3n),
	permissionTargetChannelId: createChannelID(4n),
	mode: 'thread' as const,
};
const guild = {id: '1', owner_id: '9', mfa_level: 0, nsfw: false};
const member = {success: true, member_data: {user: {id: '2'}, communication_disabled_until: null}};
const response = () => ({
	response_version: 1,
	guild,
	parent_channel: {id: '3', type: 4, nsfw_override: null},
	member,
	permissions: '1024',
	context_channel_id: '3',
	permission_target_channel_id: '4',
	mode: 'thread',
});
let service: GatewayService;
afterEach(async () => {
	service?.destroy();
	await GatewayRpcClient.resetForTests();
});
/** 构造可控制网关响应与批处理时机的测试服务。 */
function setup(fn: (method: string, params: Record<string, unknown>) => unknown) {
	const calls: Array<{method: string; params: Record<string, unknown>}> = [];
	GatewayRpcClient.createForTests({
		async call(method, p) {
			calls.push({method, params: p});
			return await fn(method, p);
		},
		async destroy() {},
	});
	service = new GatewayService();
	return calls;
}

describe('combined channel authorization transport', () => {
	it('retains schema-optional NSFW field defaults without an extra RPC', async () => {
		const value = response();
		delete (value.guild as {nsfw?: boolean}).nsfw;
		delete (value.parent_channel as {nsfw_override?: boolean | null}).nsfw_override;
		const calls = setup(() => value);
		await service.getGuildChannelAuthorization(params);
		expect(calls).toHaveLength(1);
	});
	it.each([{guild: {...guild, nsfw: 'false'}}, {parent_channel: {id: '3', type: 4, nsfw_override: 0}}])(
		'rejects wrong defined optional auth fields',
		async (patch) => {
			const calls = setup(() => ({...response(), ...patch}));
			await expect(service.getGuildChannelAuthorization(params)).rejects.toThrow();
			expect(calls).toHaveLength(1);
		},
	);

	it('uses one RPC for context/member/decimal permission and dedupes identical in-flight keys', async () => {
		const calls = setup(() => response());
		const [a, b] = await Promise.all([
			service.getGuildChannelAuthorization(params),
			service.getGuildChannelAuthorization(params),
		]);
		expect(a.permissions).toBe(1024n);
		expect(a.memberResult.memberData?.user.id).toBe('2');
		expect(b).toEqual(a);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual({
			method: 'guild.get_channel_authorization',
			params: {guild_id: '1', user_id: '2', context_channel_id: '3', permission_target_channel_id: '4', mode: 'thread'},
		});
	});
	it('keeps context, permission target and mode distinct in its dedupe key', async () => {
		const calls = setup((_m, p) => ({
			...response(),
			context_channel_id: p.context_channel_id,
			parent_channel: {id: p.context_channel_id, type: 4, nsfw_override: null},
			permission_target_channel_id: p.permission_target_channel_id,
			mode: p.mode,
		}));
		await Promise.all([
			service.getGuildChannelAuthorization(params),
			service.getGuildChannelAuthorization({...params, channelId: createChannelID(5n)}),
			service.getGuildChannelAuthorization({...params, permissionTargetChannelId: createChannelID(5n)}),
			service.getGuildChannelAuthorization({...params, mode: 'channel'}),
		]);
		expect(calls).toHaveLength(4);
	});
	it.each(['member', 'permissions'] as const)('legacy responses supplement only missing %s', async (missing) => {
		const legacy: Record<string, unknown> = {guild, parent_channel: {id: '3', type: 4}, member, permissions: '1024'};
		delete legacy[missing];
		const calls = setup((method) =>
			method === 'guild.get_channel_authorization'
				? legacy
				: method === 'guild.get_member'
					? member
					: {permissions: '1024'},
		);
		await service.getGuildChannelAuthorization(params);
		expect(calls.map((c) => c.method)).toEqual([
			'guild.get_channel_authorization',
			missing === 'member' ? 'guild.get_member' : 'guild.get_user_permissions',
		]);
	});
	it.each([
		{response_version: 2},
		{permissions: 1024},
		{permissions: '-1'},
		{member: undefined},
		{member: {success: true, member_data: {user: {id: '8'}}}},
		{guild: {id: '1'}},
		{guild: {...guild, id: '8'}},
		{guild: {...guild, mfa_level: undefined}},
		{context_channel_id: '8'},
		{permission_target_channel_id: '8'},
		{mode: 'channel'},
		{parent_channel: {id: '8', type: 4, nsfw_override: null}},
	])('rejects malformed new protocol without supplement/retry: %j', async (patch) => {
		const calls = setup(() => ({...response(), ...patch}));
		await expect(service.getGuildChannelAuthorization(params)).rejects.toThrow();
		expect(calls).toHaveLength(1);
	});
	it.each([GatewayRpcMethodErrorCodes.FORBIDDEN, GatewayRpcMethodErrorCodes.GUILD_OVERLOADED, 'unknown_method'])(
		'never falls back on RPC error %s',
		async (code) => {
			const calls = setup(() => {
				throw new GatewayRpcMethodError(code);
			});
			await expect(service.getGuildChannelAuthorization(params)).rejects.toThrow();
			expect(calls).toHaveLength(1);
		},
	);
	it('does not fan out on timeout', async () => {
		const calls = setup(() => {
			throw new GatewayTimeoutError();
		});
		await expect(service.getGuildChannelAuthorization(params)).rejects.toThrow();
		expect(calls).toHaveLength(1);
	});
	it('preserves a zero-permission response and explicit missing-member result', async () => {
		setup(() => ({...response(), member: {success: false}, permissions: '0'}));
		const result = await service.getGuildChannelAuthorization(params);
		expect(result.permissions).toBe(0n);
		expect(result.memberResult).toEqual({success: false});
	});
});
