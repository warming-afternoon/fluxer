// SPDX-License-Identifier: AGPL-3.0-or-later

import {Config} from '@app/api/Config';
import {isInternalRpcRoutingValid} from '@app/api/rpc/InternalRpcRouting';
import type {HonoApp} from '@app/api/types/HonoEnv';
import {constantTimeEquals} from '@app/api/utils/SecretHash';
import {Validator} from '@app/api/Validator';
import {InputValidationError} from '@fluxer/errors/src/domains/core/InputValidationError';
import {UnauthorizedError} from '@fluxer/errors/src/domains/core/UnauthorizedError';
import {RpcRequest} from '@fluxer/schema/src/domains/rpc/RpcSchemas';

const INTERNAL_RPC_AUTH_HEADER = 'x-fluxer-rpc-auth';

function isValidInternalRpcToken(providedToken: string): boolean {
	const expectedToken = Config.internal.gatewayRpcAuthToken;
	return expectedToken.length > 0 && constantTimeEquals(expectedToken, providedToken);
}

export function InternalRpcController(app: HonoApp): void {
	app.post('/internal/rpc', Validator('json', RpcRequest), async (ctx) => {
		const providedToken = ctx.req.header(INTERNAL_RPC_AUTH_HEADER) ?? '';
		if (!isValidInternalRpcToken(providedToken)) {
			throw new UnauthorizedError();
		}
		const request = ctx.req.valid('json');
		// 完整鉴权后校验路由提示，错误标记不能把写操作伪装成查询。
		if (
			!isInternalRpcRoutingValid(
				request.type,
				ctx.req.header('x-fluxer-rpc-type'),
				ctx.req.header('x-fluxer-rpc-request-id'),
			)
		) {
			throw InputValidationError.create('routing', 'Invalid internal RPC routing metadata');
		}
		const rpcService = ctx.get('rpcService');
		const requestCache = ctx.get('requestCache');
		const response = await rpcService.handleRpcRequest({request, requestCache});
		return ctx.json(response);
	});
}
