// SPDX-License-Identifier: AGPL-3.0-or-later

/** 校验可选私有路由信息，路由标记不能改变正文中的实际操作 */
export function isInternalRpcRoutingValid(
	requestType: string,
	declaredType: string | undefined,
	requestId: string | undefined,
): boolean {
	// 缺少私有头的旧调用继续兼容，存在的标记必须单值且与正文一致。
	if (declaredType !== undefined && declaredType !== requestType) return false;
	if (requestId !== undefined && !/^[a-f0-9]{32}$/.test(requestId)) return false;
	return true;
}
