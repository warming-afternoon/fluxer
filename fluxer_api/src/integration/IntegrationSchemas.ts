// SPDX-License-Identifier: AGPL-3.0-or-later

import {isIP} from 'node:net';
import {z} from 'zod';

export const IdentityId = z
	.string()
	.regex(/^[1-9][0-9]{0,19}$/)
	.refine((id) => BigInt(id) <= 9223372036854775807n);
export const OperationId = z
	.string()
	.min(16)
	.max(128)
	.regex(/^[a-zA-Z0-9_-]+$/);
export const Profile = z
	.object({
		/** 首次创建账户时使用的 Discord 用户名 */
		username: z.string().min(1).max(80),

		/** 首次创建账户时使用的 Discord 昵称 */
		display_name: z.string().max(80).nullable(),

		/** 官方 CDN 上的初始 Discord 头像地址 */
		avatar_url: z
			.string()
			.max(512)
			.url()
			.refine((value) => {
				const url = new URL(value);
				return (
					url.protocol === 'https:' &&
					url.hostname === 'cdn.discordapp.com' &&
					url.pathname.startsWith('/avatars/') &&
					!url.username &&
					!url.password
				);
			})
			.nullable(),
	})
	.strict();
const Envelope = z.object({
	/** 固定的集成协议版本 */
	version: z.literal(1),

	/** 本次 RPC 请求标识，允许在幂等重试时变化 */
	request_id: OperationId,
});
const Token = z.string().regex(/^flx_[a-zA-Z0-9]{36}$/);
const VerifiedAt = z.iso.datetime({offset: true});
export const IntegrationSchemas = {
	'rpc.integration.v1.service_info': Envelope.strict(),
	'rpc.identity.v1.ensure_discord': Envelope.extend({
		/** 经调用方验证的 Discord 主体 */
		discord_user_id: IdentityId,

		/** 仅在初次账户创建时导入的资料 */
		profile: Profile,

		/** 身份预建的幂等操作标识 */
		operation_id: OperationId,
	}).strict(),
	'rpc.identity.v1.lookup_discord': Envelope.extend({
		/** 本次批量查询的 Discord 主体 */
		discord_user_ids: z.array(IdentityId).min(1).max(100),
	}).strict(),
	'rpc.identity.v1.profiles': Envelope.extend({
		/** 本次批量读取资料的原生用户 */
		user_ids: z.array(IdentityId).min(1).max(100),
	}).strict(),
	'rpc.auth.v1.session.resolve': Envelope.extend({
		/** 需要读取权威会话状态的原生令牌 */
		token: Token,
	}).strict(),
	'rpc.auth.v1.session.revoke_current': Envelope.extend({
		/** 仅撤销此令牌对应的当前原生会话 */
		token: Token,
	}).strict(),
	'rpc.auth.v1.external.exchange': Envelope.extend({
		/** 绑定不可变请求及短期返回凭据的交换标识 */
		exchange_id: OperationId,

		/** 经调用方验证的 Discord 主体 */
		discord_user_id: IdentityId,

		/** 调用方最近完成 Discord 验证的时间 */
		verified_at: VerifiedAt,

		/** 仅在初次账户创建时导入的资料 */
		profile: Profile,

		/** 创建原生会话所需的客户端来源 */
		origin: z
			.object({
				/** 发起登录的客户端 IP */
				ip: z.string().refine((value) => isIP(value) !== 0),

				/** 客户端上报的用户代理 */
				user_agent: z.string().max(1024).nullable(),

				/** 客户端上报的操作系统 */
				client_os: z.string().max(64).nullable(),
			})
			.strict(),
	}).strict(),
	'rpc.auth.v1.external.prove': Envelope.extend({
		/** 证明仅授权首次设置原生密码 */
		purpose: z.literal('set_initial_password'),

		/** 证明绑定的当前原生会话令牌 */
		token: Token,

		/** 必须与当前会话账户匹配的 Discord 主体 */
		discord_user_id: IdentityId,

		/** 调用方最近完成 Discord 验证的时间 */
		verified_at: VerifiedAt,

		/** 本次证明申请的操作标识 */
		operation_id: OperationId,
	}).strict(),
};
export type DiscordProfile = z.infer<typeof Profile>;
