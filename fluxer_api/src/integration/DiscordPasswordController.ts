// SPDX-License-Identifier: AGPL-3.0-or-later

import {deleteRecoveryKit} from '@app/api/auth/AuthRecoveryKit';
import * as AuthSession from '@app/api/auth/AuthSession';
import {requireSudoMode} from '@app/api/auth/services/SudoVerificationService';
import {DefaultUserOnly, LoginRequired} from '@app/api/middleware/AuthMiddleware';
import {LocalAuthMiddleware} from '@app/api/middleware/LocalAuthMiddleware';
import {RateLimitMiddleware} from '@app/api/middleware/RateLimitMiddleware';
import {OpenAPI} from '@app/api/middleware/ResponseTypeMiddleware';
import {SudoModeMiddleware} from '@app/api/middleware/SudoModeMiddleware';
import {RateLimitConfigs} from '@app/api/RateLimitConfig';
import type {HonoApp} from '@app/api/types/HonoEnv';
import {AuthSessionRepository} from '@app/api/user/repositories/auth/AuthSessionRepository';
import {isAccountClosed, isTemporarilyBanned} from '@app/api/user/UserHelpers';
import {Validator} from '@app/api/Validator';
import {consumeDiscordPasswordProof} from '@app/integration/DiscordPasswordProof';
import {IntegrationError} from '@app/integration/IntegrationError';
import {UserFlags} from '@fluxer/constants/src/UserConstants';
import {ValidationErrorCodes} from '@fluxer/constants/src/ValidationErrorCodes';
import {InputValidationError} from '@fluxer/errors/src/domains/core/InputValidationError';
import {InvalidTokenError} from '@fluxer/errors/src/domains/core/InvalidTokenError';
import {UserPasswordUpdateRequest} from '@fluxer/schema/src/domains/user/UserRequestSchemas';
import {UserPasswordUpdateResponse} from '@fluxer/schema/src/domains/user/UserResponseSchemas';
import {z} from 'zod';

const DiscordPasswordRequest = UserPasswordUpdateRequest.extend({
	/** 与当前用户、会话及新鲜 Discord 登录绑定的一次性证明 */
	proof: z.string().regex(/^[a-zA-Z0-9_-]{43}$/),
});

/** 为社区外部登录账号提供独立的首次密码设置入口，保留原生 SSO 规则 */
export function DiscordPasswordController(app: HonoApp): void {
	app.post(
		'/users/@me/discord-password',
		RateLimitMiddleware(RateLimitConfigs.USER_PASSWORD_UPDATE),
		LocalAuthMiddleware,
		LoginRequired,
		DefaultUserOnly,
		SudoModeMiddleware,
		Validator('json', DiscordPasswordRequest),
		OpenAPI({
			operationId: 'set_discord_account_initial_password',
			summary: 'Set initial password after trusted Discord verification',
			responseSchema: UserPasswordUpdateResponse,
			statusCode: 200,
			security: ['sessionToken'],
			tags: ['Users'],
			description:
				'Consumes a short-lived proof bound to this native session. Existing MFA is required. Rotates sessions.',
		}),
		async (ctx) => {
			const session = ctx.get('authSession');
			const apiContext = ctx.get('apiContext');
			const user = ctx.get('user');
			const body = ctx.req.valid('json');
			if (!session || !user.traits.has('discord_integration') || user.passwordHash !== null) {
				throw InputValidationError.fromCode('proof', ValidationErrorCodes.INVALID_PROOF_TOKEN);
			}
			const lockKey = `integration:initial-password:${user.id}`;
			const cache = apiContext.services.cache;
			const lock = await cache.acquireLock(lockKey, 120);
			if (!lock) return ctx.json({code: 'PASSWORD_SETUP_BUSY', message: 'Password setup already in progress'}, 409);
			try {
				const freshUser = await apiContext.services.users.findUnique(user.id);
				const liveSession = await new AuthSessionRepository().getAuthoritativeAuthSession(session.sessionIdHash);
				if (
					!liveSession ||
					liveSession.userId !== user.id ||
					!freshUser ||
					isAccountClosed(freshUser) ||
					isTemporarilyBanned(freshUser) ||
					(freshUser.flags & (UserFlags.DISABLED | UserFlags.SELF_DELETED)) !== 0n
				) {
					throw new InvalidTokenError();
				}
				if (!freshUser || freshUser.passwordHash !== null || !freshUser.traits.has('discord_integration')) {
					throw InputValidationError.fromCode('proof', ValidationErrorCodes.INVALID_PROOF_TOKEN);
				}
				// 使用新鲜账户状态执行原生敏感操作验证，失败时不消耗一次性证明。
				await requireSudoMode(ctx, freshUser, body, {issueSudoToken: false});
				try {
					await consumeDiscordPasswordProof(
						cache,
						body.proof,
						user.id.toString(),
						Buffer.from(session.sessionIdHash).toString('base64url'),
					);
				} catch (error) {
					if (error instanceof IntegrationError) {
						throw InputValidationError.fromCode('proof', ValidationErrorCodes.INVALID_PROOF_TOKEN);
					}
					throw error;
				}
				const updated = await ctx.get('passwordChangeService').setPassword(freshUser, body.new_password);
				await apiContext.services.users.deleteAllPasswordResetTokens(user.id);
				await deleteRecoveryKit(user.id);
				const replacement = await AuthSession.replaceCurrentAuthSession(apiContext, {
					user: updated,
					currentAuthSession: session,
					request: ctx.req.raw,
				});
				return ctx.json({token: replacement.token, auth_session_id_hash: replacement.newAuthSessionIdHash});
			} finally {
				await cache.releaseLock(lockKey, lock);
			}
		},
	);
}
