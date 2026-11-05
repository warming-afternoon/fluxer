// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ApiContext} from '@app/api/ApiContext';
import {createUserID, type UserID} from '@app/api/BrandedTypes';
import {discordUsernameBase} from '@app/integration/DiscordUsername';
import {IntegrationError} from '@app/integration/IntegrationError';
import {publishIntegrationEvent} from '@app/integration/IntegrationEvents';
import {type DiscordBinding, IntegrationIdentityRepository} from '@app/integration/IntegrationIdentityRepository';
import type {DiscordProfile} from '@app/integration/IntegrationSchemas';
import {NativeAccountRepository} from '@app/integration/NativeAccountRepository';
import {GlobalNameType} from '@fluxer/schema/src/primitives/UserValidators';

export class DiscordAccountService {
	/** 使用稳定事件标识恢复首次绑定提交后未完成的发布 */
	private async publishBinding(binding: DiscordBinding, userId: UserID): Promise<void> {
		// 历史别名与跨账户合并只能由管理事件变更，普通登录不能重新选定当前身份。
		if (userId !== binding.user_id || (await this.identities.findDiscordId(userId)) !== binding.discord_user_id) return;
		const version = await this.identities.bindingVersion(userId);
		await publishIntegrationEvent(
			'events.identity.v1.binding_changed',
			{
				kind: 'binding_changed',
				discord_user_id: binding.discord_user_id,
				user_id: userId.toString(),
				affected_user_ids: [userId.toString()],
				version,
			},
			{eventId: `${binding.operation_id}:binding:${userId}:${version}`},
		);
	}
	/** 注入可替换仓储以验证并发和恢复路径 */
	constructor(
		private readonly context: ApiContext,
		private readonly identities = new IntegrationIdentityRepository(),
		private readonly native = new NativeAccountRepository(context),
	) {}

	/** Bot 预建和 Forum 登录共享唯一账户创建路径 */
	async ensureDiscordAccount(discordId: string, profile: DiscordProfile, operationId: string) {
		// 首次占用保存初始资料，后续请求沿用原绑定以恢复中断的创建。
		let binding = await this.identities.find(discordId);
		if (!binding) {
			const userId = createUserID(await this.context.services.snowflake.generate());
			const username = discordUsernameBase(profile.username);
			const displayName = GlobalNameType.safeParse(profile.display_name);
			binding = await this.identities.claim(
				discordId,
				userId,
				operationId,
				{...profile, display_name: displayName.success ? displayName.data : null},
				username,
			);
		}
		// 完成的绑定只读取原生账户，不能重新建号或覆盖已经修改的资料。
		if (binding.state === 'ready') {
			const user = await this.context.services.users.findUnique(await this.identities.canonicalUserId(binding.user_id));
			if (!user) throw new IntegrationError('BOUND_ACCOUNT_MISSING', 'Bound native account is missing');
			await this.publishBinding(binding, user.id);
			return {user, created: false, binding};
		}
		await this.identities.ensureReverse(binding);
		const user = await this.native.initialize(binding);
		await this.identities.complete(binding);
		await this.publishBinding(binding, user.id);
		return {user, created: binding.operation_id === operationId, binding};
	}
}
