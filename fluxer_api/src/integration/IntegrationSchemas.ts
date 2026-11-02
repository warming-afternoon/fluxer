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
const ServiceOperation = Envelope.extend({
	/** Forum 已完成业务授权的真实原生操作人 */
	actor_user_id: IdentityId,

	/** 永久幂等标识 */
	operation_id: OperationId,

	/** 只允许配置中的原生服务器 */
	guild_id: IdentityId,
});
export const IntegrationSchemas = {
	'rpc.content.v1.thread.update_service': ServiceOperation.extend({
		/** 操作只限允许论坛中的原生帖子 */
		thread_id: IdentityId,

		/** 仅更新标题，不能通过此能力修改成员或权限 */
		name: z.string().min(1).max(100).optional(),

		/** 原生归档状态，不能解除原生锁 */
		archived: z.boolean().optional(),
	})
		.strict()
		.refine((value) => value.name !== undefined || value.archived !== undefined),
	'rpc.content.v1.thread.move_service': ServiceOperation.extend({
		/** 保持 ID 的原生帖子 */
		thread_id: IdentityId,

		/** 允许列表中的新父论坛 */
		target_channel_id: IdentityId,
	}).strict(),
	'rpc.content.v1.thread.create_service': ServiceOperation.extend({
		/** 新子帖初始化期间保持独立外部锁，调用方完成处罚对账后显式释放 */
		defer_open: z.boolean().optional(),

		/** 受信调用方在新帖子开放前继承的完整发言处罚快照 */
		initial_policies: z
			.array(
				z
					.object({
						/** 独立来源，不能覆盖原生锁 */
						source: z.string().regex(/^forum_[a-zA-Z0-9_-]{1,64}$/),

						/** 来源内单调版本 */
						policy_version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),

						/** 处罚目标原生用户 */
						target_user_id: IdentityId,

						/** 是否生效，撤销也保留版本 */
						active: z.boolean(),

						/** 用户处罚可有期限，空值表示永久 */
						expires_at: VerifiedAt.nullable().optional(),
					})
					.strict(),
			)
			.max(100)
			.optional(),

		/** 创建子帖时的逻辑父讨论区，用于执行通用用户发言处罚 */
		parent_thread_id: IdentityId.optional(),

		/** 允许列表中的父论坛 */
		channel_id: IdentityId,

		/** 原生帖子标题 */
		name: z.string().min(1).max(100),

		/** 原生主帖正文，附件继续使用原生上传接口 */
		content: z.string().min(1).max(4000),
	}).strict(),
	'rpc.content.v1.thread.policy_service': ServiceOperation.extend({
		/** 策略作用的原生帖子 */
		thread_id: IdentityId,

		/** Forum 策略来源，与原生锁完全独立 */
		source: z.string().regex(/^forum_[a-zA-Z0-9_-]{1,64}$/),

		/** 来源内单调版本 */
		policy_version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),

		/** 仅发言处罚或外部锁 */
		kind: z.enum(['deny_send', 'lock']),

		/** 用户发言处罚的目标，锁不填写 */
		target_user_id: IdentityId.optional(),

		/** 是否生效 */
		active: z.boolean(),

		/** 到期时间，空值表示永久 */
		expires_at: VerifiedAt.nullable().optional(),
	})
		.strict()
		.refine((value) =>
			value.kind === 'lock'
				? value.target_user_id === undefined && value.expires_at == null
				: value.target_user_id !== undefined,
		),
	'rpc.content.v1.starter.edit_service': ServiceOperation.extend({
		/** 原生帖子，其首消息 ID 相同 */
		thread_id: IdentityId,

		/** 更新后的正文 */
		content: z.string().max(4000),
	}).strict(),
	'rpc.content.v1.thread.read_service': ServiceOperation.extend({
		/** 读取原生主帖与元数据 */
		thread_id: IdentityId,
	}).strict(),
	'rpc.identity.v1.rebind_service': Envelope.extend({
		/** 本次操作持久化幂等标识 */
		operation_id: OperationId,

		/** Forum 已完成管理组鉴权的真实操作人 */
		actor_user_id: IdentityId,

		/** 保留密码和原生 ID 的规范账户 B */
		user_id: IdentityId,

		/** 经 Forum 新鲜 OAuth 验证的新主体 */
		discord_user_id: IdentityId,

		/** 管理组操作原因，保留在永久审计上下文中 */
		reason: z.string().min(1).max(512),

		/** 缺少预建账户时使用的初始资料 */
		profile: Profile,
	}).strict(),
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
