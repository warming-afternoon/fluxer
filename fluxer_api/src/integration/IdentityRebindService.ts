// SPDX-License-Identifier: AGPL-3.0-or-later

import {createHash} from 'node:crypto';
import type {ApiContext} from '@app/api/ApiContext';
import {revokeAllAuthSessions} from '@app/api/auth/AuthSessionRevocation';
import {createUserID} from '@app/api/BrandedTypes';
import {isAccountClosed, isTemporarilyBanned} from '@app/api/user/UserHelpers';
import {DiscordAccountService} from '@app/integration/DiscordAccountService';
import {IntegrationError} from '@app/integration/IntegrationError';
import {publishIntegrationEvent} from '@app/integration/IntegrationEvents';
import {IntegrationIdentityRepository} from '@app/integration/IntegrationIdentityRepository';
import {IntegrationOperationRepository} from '@app/integration/IntegrationOperationRepository';
import type {IntegrationSchemas} from '@app/integration/IntegrationSchemas';
import {UserFlags} from '@fluxer/constants/src/UserConstants';
import type {z} from 'zod';

type RebindRequest = z.infer<(typeof IntegrationSchemas)['rpc.identity.v1.rebind_service']>;

interface RebindPlan {
	/** 明确管理授权的真实操作人 */
	actor_user_id: string;

	/** 管理操作原因 */
	reason: string;

	/** 保持不变的规范原生账户 */
	user_id: string;

	/** 新的唯一可登录 Discord 主体 */
	discord_user_id: string;

	/** 换绑前的登录主体 */
	previous_discord_user_id: string;

	/** 仅作历史归属投影的原生预建账户 */
	merged_user_id: string | null;

	/** 首次授权时确定的操作版本 */
	version: number;
}

export class IdentityRebindService {
	/** 已完成操作重发稳定失效事件，关闭完成结果与发布之间的崩溃窗口 */
	private async publishResult(plan: RebindPlan, operationId: string): Promise<void> {
		await publishIntegrationEvent(
			'events.identity.v1.binding_changed',
			{
				discord_user_id: plan.discord_user_id,
				previous_discord_user_id: plan.previous_discord_user_id,
				user_id: plan.user_id,
				version: plan.version,
				...(plan.merged_user_id ? {merged_user_id: plan.merged_user_id} : {}),
			},
			{eventId: `${operationId}:binding`},
		);
		for (const userId of [plan.user_id, ...(plan.merged_user_id ? [plan.merged_user_id] : [])])
			await publishIntegrationEvent(
				'events.auth.v1.user_invalidated',
				{user_id: userId},
				{eventId: `${operationId}:user:${userId}`},
			);
	}
	/** 注入原生账户依赖及可替换仓储以验证中断恢复 */
	constructor(
		private readonly context: ApiContext,
		private readonly identities = new IntegrationIdentityRepository(),
		private readonly operations = new IntegrationOperationRepository(),
		private readonly accounts = new DiscordAccountService(context),
	) {}

	/** 将新身份归入稳定账户，保留所有原生消息作者和密码 */
	async rebind(request: RebindRequest): Promise<RebindPlan> {
		const key = `integration:operation:${request.operation_id}`;
		const lease = await this.context.services.cache.acquireLock(key, 120);
		if (!lease) throw new IntegrationError('BUSY', 'Operation is already running', true);
		try {
			return await this.execute(request, async () => {
				if (!(await this.context.services.cache.extendLock(key, lease, 120)))
					throw new IntegrationError('BUSY', 'Operation lease expired; retry the same operation', true);
			});
		} finally {
			await this.context.services.cache.releaseLock(key, lease);
		}
	}

	/** 每个持久步骤前验证执行租约，使并发请求不能复活已完成的操作 */
	private async execute(request: RebindRequest, assertLease: () => Promise<void>): Promise<RebindPlan> {
		const fingerprint = createHash('sha256')
			.update(JSON.stringify({...request, request_id: undefined}))
			.digest('hex');
		// 服务凭据承担管理授权，日志仅保存真实管理员而不持久化原始会话。
		const administrator = await this.context.services.users.findUnique(createUserID(BigInt(request.actor_user_id)));
		if (
			!administrator ||
			isAccountClosed(administrator) ||
			isTemporarilyBanned(administrator) ||
			(administrator.flags & UserFlags.DISABLED) !== 0n
		)
			throw new IntegrationError('ACCOUNT_UNAVAILABLE', 'Administrator account is unavailable');
		let operation = await this.operations.find(request.operation_id);
		if (operation && operation.fingerprint !== fingerprint)
			throw new IntegrationError('OPERATION_CONFLICT', 'Operation belongs to another request');
		if (!operation) {
			const user = await this.context.services.users.findUnique(createUserID(BigInt(request.user_id)));
			if (!user || isAccountClosed(user) || isTemporarilyBanned(user) || (user.flags & UserFlags.DISABLED) !== 0n)
				throw new IntegrationError('ACCOUNT_UNAVAILABLE', 'Target account is unavailable');
			const previous = await this.identities.findDiscordId(user.id);
			if (!previous) throw new IntegrationError('IDENTITY_CONFLICT', 'Account has no Discord identity');
			const target = await this.accounts.ensureDiscordAccount(
				request.discord_user_id,
				request.profile,
				request.operation_id,
			);
			if (target.user.id !== user.id && !target.user.traits.has('discord_integration'))
				throw new IntegrationError('IDENTITY_CONFLICT', 'Merge source is not an integration account');
			const plan: RebindPlan = {
				actor_user_id: request.actor_user_id,
				reason: request.reason,
				user_id: user.id.toString(),
				discord_user_id: request.discord_user_id,
				previous_discord_user_id: previous,
				merged_user_id: target.user.id === user.id ? null : target.user.id.toString(),
				version: Date.now(),
			};
			operation = await this.operations.allocate({
				operation_id: request.operation_id,
				fingerprint,
				actor_id: administrator.id,
				payload: JSON.stringify(plan),
				result: null,
			});
		}
		const plan = JSON.parse(operation.payload) as RebindPlan;
		const userId = createUserID(BigInt(plan.user_id));
		const sourceId = plan.merged_user_id ? createUserID(BigInt(plan.merged_user_id)) : null;
		if (operation.result) {
			await this.identities.unlockRebind(userId, request.operation_id);
			if (sourceId) await this.identities.unlockRebind(sourceId, request.operation_id);
			const result = JSON.parse(operation.result) as RebindPlan;
			await this.publishResult(result, request.operation_id);
			return result;
		}
		const actor = await this.context.services.users.findUnique(userId);
		if (!actor || isAccountClosed(actor) || isTemporarilyBanned(actor) || (actor.flags & UserFlags.DISABLED) !== 0n)
			throw new IntegrationError('ACCOUNT_UNAVAILABLE', 'Account is unavailable');
		// 持久化锁使崩溃后的登录失败关闭；同一授权操作只能恢复原计划。
		const lockedUsers = sourceId
			? [userId, sourceId].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
			: [userId];
		for (const id of lockedUsers) await this.identities.lockRebind(id, request.operation_id);
		// 并发重试可能在等待锁时观察到同一操作已完成，不再重复业务步骤。
		const latest = await this.operations.find(request.operation_id);
		if (latest?.result) {
			await this.identities.unlockRebind(userId, request.operation_id);
			if (sourceId) await this.identities.unlockRebind(sourceId, request.operation_id);
			const result = JSON.parse(latest.result) as RebindPlan;
			await this.publishResult(result, request.operation_id);
			return result;
		}
		const currentDiscord = await this.identities.currentDuringRebind(userId, request.operation_id);
		if (currentDiscord !== plan.previous_discord_user_id && currentDiscord !== plan.discord_user_id) {
			for (const id of lockedUsers) await this.identities.unlockRebind(id, request.operation_id);
			throw new IntegrationError('IDENTITY_CONFLICT', 'Another completed identity change superseded this plan');
		}
		if (sourceId) {
			await assertLease();
			const source = await this.context.services.users.findUnique(sourceId);
			const canonical = await this.identities.canonicalUserId(sourceId);
			if (!source?.traits.has('discord_integration') || (canonical !== sourceId && canonical !== userId))
				throw new IntegrationError('IDENTITY_CONFLICT', 'Merge source no longer matches the authorized plan');
			await this.context.services.users.updateFlags(sourceId, (flags) => flags | UserFlags.DISABLED);
			await assertLease();
			await revokeAllAuthSessions(this.context.services, sourceId);
			await assertLease();
			await this.identities.mergeUser(sourceId, userId, request.operation_id);
		}
		await assertLease();
		plan.version = await this.identities.setCurrent(userId, plan.discord_user_id, request.operation_id, plan.version);
		await revokeAllAuthSessions(this.context.services, userId);
		await assertLease();
		// 先完成永久结果再释放门禁；完成结果重试不再次撤销新登录会话。
		await this.operations.complete(request.operation_id, plan);
		await this.identities.unlockRebind(userId, request.operation_id);
		if (sourceId) await this.identities.unlockRebind(sourceId, request.operation_id);
		await this.publishResult(plan, request.operation_id);
		return plan;
	}
}
