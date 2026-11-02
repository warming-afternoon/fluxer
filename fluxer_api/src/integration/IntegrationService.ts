// SPDX-License-Identifier: AGPL-3.0-or-later

import {createHash} from 'node:crypto';
import type {ApiContext} from '@app/api/ApiContext';
import * as AuthSession from '@app/api/auth/AuthSession';
import {revokeAuthSessions} from '@app/api/auth/AuthSessionRevocation';
import {generateAuthToken} from '@app/api/auth/AuthUtility';
import {createUserID, type UserID} from '@app/api/BrandedTypes';
import type {User} from '@app/api/models/User';
import {AuthSessionRepository} from '@app/api/user/repositories/auth/AuthSessionRepository';
import {isAccountClosed, isTemporarilyBanned} from '@app/api/user/UserHelpers';
import {DiscordAccountService} from '@app/integration/DiscordAccountService';
import {issueDiscordPasswordProof} from '@app/integration/DiscordPasswordProof';
import {IdentityRebindService} from '@app/integration/IdentityRebindService';
import {IntegrationContentService} from '@app/integration/IntegrationContentService';
import {IntegrationError} from '@app/integration/IntegrationError';
import type {IntegrationExchangeRepository} from '@app/integration/IntegrationExchangeRepository';
import {IntegrationIdentityRepository} from '@app/integration/IntegrationIdentityRepository';
import {IntegrationSchemas} from '@app/integration/IntegrationSchemas';
import {UserFlags} from '@fluxer/constants/src/UserConstants';

export class IntegrationService {
	private readonly accounts: DiscordAccountService;
	private readonly identities = new IntegrationIdentityRepository();
	private readonly sessions = new AuthSessionRepository();

	/** 复用原生业务服务并注入交换持久化 */
	constructor(
		private readonly context: ApiContext,
		private readonly exchanges: IntegrationExchangeRepository,
	) {
		this.accounts = new DiscordAccountService(context);
	}

	/** 原生会话及旧版 Discord 登录资格共用同一权威账号状态判断。 */
	private async availableUser(userId: UserID): Promise<User> {
		const user = await this.context.services.users.findUnique(userId);
		if (
			!user ||
			user.isBot ||
			isAccountClosed(user) ||
			isTemporarilyBanned(user) ||
			(user.flags & (UserFlags.DISABLED | UserFlags.SELF_DELETED)) !== 0n ||
			user.traits.has('registration_pending_approval') ||
			user.traits.has('registration_rejected')
		) {
			throw new IntegrationError('ACCOUNT_UNAVAILABLE', 'Account is unavailable');
		}
		return user;
	}

	/** 权威读取会话和账户状态，拒绝禁用及待审批账户 */
	async resolve(token: string) {
		// 绕过会话缓存读取权威状态，撤销和账户禁用即时影响本次解析。
		const hash = createHash('sha256').update(token).digest();
		const session = await this.sessions.getAuthoritativeAuthSession(hash);
		if (!session) throw new IntegrationError('INVALID_TOKEN', 'Session is invalid');
		const user = await this.availableUser(session.userId);
		if (user.traits.has('discord_integration')) await this.identities.findDiscordId(user.id);
		return {user, session, hash: hash.toString('base64url')};
	}

	/** 从原生资料生成 Forum 可读取字段 */
	profile(user: User) {
		return {
			user_id: user.id.toString(),
			username: user.username,
			display_name: user.globalName,
			avatar_url: user.avatarHash
				? `${this.context.services.config.endpoints.media}/avatars/${user.id}/${user.avatarHash}.png`
				: null,
		};
	}

	/** 验证受信调用方的新鲜 Discord 认证断言 */
	verifyFresh(verifiedAt: string): number {
		const timestamp = Date.parse(verifiedAt);
		const age = Date.now() - timestamp;
		if (!Number.isFinite(timestamp) || age > 120_000 || age < -30_000)
			throw new IntegrationError('STALE_EXTERNAL_PROOF', 'External verification must be recent');
		return timestamp;
	}

	/** 分发严格校验过的有界 RPC，敏感字段永不返回日志 */
	async dispatch(subject: string, input: unknown): Promise<unknown> {
		if (subject.startsWith('rpc.content.')) return new IntegrationContentService(this.context).dispatch(subject, input);
		switch (subject) {
			case 'rpc.identity.v1.rebind_service':
				return new IdentityRebindService(this.context).rebind(IntegrationSchemas[subject].parse(input));
			case 'rpc.integration.v1.service_info': {
				IntegrationSchemas[subject].parse(input);
				await this.identities.checkHealth();
				await this.context.services.cache.get('integration:readiness');
				return {service: 'fluxer-integration', version: 1, ready: true};
			}
			case 'rpc.identity.v1.ensure_discord': {
				const request = IntegrationSchemas[subject].parse(input);
				const result = await this.accounts.ensureDiscordAccount(
					request.discord_user_id,
					request.profile,
					request.operation_id,
				);
				return {user_id: result.user.id.toString(), discord_user_id: request.discord_user_id, created: result.created};
			}
			case 'rpc.identity.v1.lookup_discord': {
				const request = IntegrationSchemas[subject].parse(input);
				const records = await this.identities.findMany([...new Set(request.discord_user_ids)]);
				const bindings = await Promise.all(
					records
						.filter((binding) => binding.state === 'ready')
						.map(async (binding) => {
							const canonical = await this.identities.canonicalUserId(binding.user_id);
							return {
								discord_user_id: binding.discord_user_id,
								user_id: canonical.toString(),
								version: await this.identities.bindingVersion(canonical),
							};
						}),
				);
				return {bindings};
			}
			case 'rpc.identity.v1.profiles': {
				const request = IntegrationSchemas[subject].parse(input);
				const users = await this.context.services.users.listUsers(
					[...new Set(request.user_ids)].map((id) => createUserID(BigInt(id))),
				);
				return {profiles: users.filter((user) => !isAccountClosed(user)).map((user) => this.profile(user))};
			}
			case 'rpc.identity.v1.login_eligibility': {
				const request = IntegrationSchemas[subject].parse(input);
				const binding = await this.identities.find(request.discord_user_id);
				if (!binding)
					return {
						discord_user_id: request.discord_user_id,
						user_id: null,
						identity_version: null,
						current: false,
						eligible: false,
					};
				if (binding.state !== 'ready')
					throw new IntegrationError('IDENTITY_BUSY', 'Identity is not ready for login', true);
				try {
					const userId = await this.identities.canonicalUserId(binding.user_id);
					const version = await this.identities.bindingVersion(userId);
					if (!Number.isSafeInteger(version) || version < 1)
						throw new IntegrationError('UNAVAILABLE', 'Identity version is unavailable', true);
					const currentDiscord = await this.identities.findDiscordId(userId);
					const current = currentDiscord === request.discord_user_id;
					let eligible = false;
					if (current) {
						try {
							await this.availableUser(userId);
							eligible = true;
						} catch (error) {
							if (!(error instanceof IntegrationError && error.code === 'ACCOUNT_UNAVAILABLE')) throw error;
						}
					}
					// 不能把换绑过程中拼接的旧主体与新版本当成一致准入结果。
					if (
						(await this.identities.findDiscordId(userId)) !== currentDiscord ||
						(await this.identities.bindingVersion(userId)) !== version
					)
						throw new IntegrationError('IDENTITY_BUSY', 'Identity changed during login verification', true);
					return {
						discord_user_id: request.discord_user_id,
						user_id: userId.toString(),
						identity_version: version,
						current,
						eligible,
					};
				} catch (error) {
					if (
						error instanceof IntegrationError &&
						['IDENTITY_BUSY', 'IDENTITY_CONFLICT', 'ACCOUNT_UNAVAILABLE'].includes(error.code)
					)
						throw new IntegrationError('IDENTITY_BUSY', 'Identity changed during login verification', true);
					throw error;
				}
			}
			case 'rpc.auth.v1.session.resolve': {
				const request = IntegrationSchemas[subject].parse(input);
				const result = await this.resolve(request.token);
				return {
					...this.profile(result.user),
					session_id_hash: result.hash,
					discord_user_id: await this.identities.findDiscordId(result.user.id),
				};
			}
			case 'rpc.auth.v1.session.revoke_current': {
				const request = IntegrationSchemas[subject].parse(input);
				const hash = createHash('sha256').update(request.token).digest();
				const session = await this.sessions.getAuthoritativeAuthSession(hash);
				if (session)
					await revokeAuthSessions(this.context.services, session.userId, [
						{sessionIdHash: hash, encodedIdHash: hash.toString('base64url')},
					]);
				return {revoked: true};
			}
			case 'rpc.auth.v1.external.prove': {
				const request = IntegrationSchemas[subject].parse(input);
				const verifiedAt = this.verifyFresh(request.verified_at);
				const {user, hash} = await this.resolve(request.token);
				const binding = await this.identities.find(request.discord_user_id);
				if (binding?.state !== 'ready' || (await this.identities.findDiscordId(user.id)) !== request.discord_user_id)
					throw new IntegrationError('IDENTITY_CONFLICT', 'Password proof does not match current account');
				if (user.passwordHash !== null || !user.traits.has('discord_integration'))
					throw new IntegrationError('PROOF_NOT_AVAILABLE', 'Initial password proof unavailable');
				return {
					proof: await issueDiscordPasswordProof(this.context.services.cache, user.id.toString(), hash, verifiedAt),
					expires_in: 120,
				};
			}
			case 'rpc.auth.v1.external.exchange': {
				const request = IntegrationSchemas[subject].parse(input);
				// 重试只允许更换请求标识，其余字段必须与最初交换完全一致。
				const fingerprint = createHash('sha256')
					.update(JSON.stringify({...request, request_id: undefined}))
					.digest('hex');
				let record = await this.exchanges.find(request.exchange_id);
				if (!record) {
					this.verifyFresh(request.verified_at);
					const {user} = await this.accounts.ensureDiscordAccount(
						request.discord_user_id,
						request.profile,
						request.exchange_id,
					);
					record = await this.exchanges.allocate(request.exchange_id, fingerprint, user.id);
				}
				if (record.fingerprint !== fingerprint)
					throw new IntegrationError('EXCHANGE_CONFLICT', 'Exchange already belongs to another request');
				if (record.expires_at.getTime() <= Date.now())
					throw new IntegrationError('EXCHANGE_EXPIRED', 'Exchange result expired');
				const user = await this.context.services.users.findUnique(record.user_id);
				if (!user) throw new IntegrationError('BOUND_ACCOUNT_MISSING', 'Bound native account is missing');
				if ((await this.identities.findDiscordId(user.id)) !== request.discord_user_id)
					throw new IntegrationError('IDENTITY_NOT_CURRENT', 'Historical Discord identity cannot sign in');
				if (record.state === 'allocated') {
					this.verifyFresh(request.verified_at);
					const token = await generateAuthToken();
					if (await this.exchanges.begin(request.exchange_id, token)) {
						await AuthSession.createAuthSession(this.context, {
							user,
							preparedToken: token,
							authMethod: 'sso',
							signedInAt: new Date(request.verified_at),
							origin: {ip: request.origin.ip, userAgent: request.origin.user_agent, clientOs: request.origin.client_os},
						});
					}
					record = await this.exchanges.read(request.exchange_id);
				}
				const token = this.exchanges.decrypt(request.exchange_id, record);
				// 创建结果不确定时只读取同一凭据，不创建第二个会话或复活已撤销会话。
				try {
					await this.resolve(token);
				} catch (error) {
					if (error instanceof IntegrationError && error.code === 'INVALID_TOKEN' && record.state !== 'complete')
						throw new IntegrationError(
							'EXCHANGE_UNCERTAIN',
							'Session creation outcome is uncertain; retry this exchange',
							true,
						);
					throw error;
				}
				await this.exchanges.complete(request.exchange_id);
				return {token, user_id: user.id.toString()};
			}
			default:
				throw new IntegrationError('UNKNOWN_METHOD', 'Unknown integration method');
		}
	}
}
