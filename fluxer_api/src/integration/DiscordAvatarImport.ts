// SPDX-License-Identifier: AGPL-3.0-or-later

import {getEntityAssetService} from '@app/api/middleware/ServiceSingletons';
import {IntegrationError} from '@app/integration/IntegrationError';
import type {DiscordBinding} from '@app/integration/IntegrationIdentityRepository';

/** 仅在初始账户创建前导入有界 Discord 图片到原生资产存储 */
export async function importDiscordAvatar(binding: DiscordBinding): Promise<string | null> {
	if (!binding.avatar_url) return null;
	// 将初始头像限制到当前 Discord 主体的官方 CDN 路径。
	const url = new URL(binding.avatar_url);
	if (
		url.protocol !== 'https:' ||
		url.hostname !== 'cdn.discordapp.com' ||
		url.port ||
		!url.pathname.startsWith(`/avatars/${binding.discord_user_id}/`)
	)
		throw new IntegrationError('INVALID_REQUEST', 'Avatar must belong to the verified Discord identity');
	const response = await fetch(url, {redirect: 'error', signal: AbortSignal.timeout(10_000)});
	const contentType = response.headers.get('content-type')?.split(';')[0];
	if (
		!response.ok ||
		!response.body ||
		!contentType ||
		!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(contentType)
	) {
		await response.body?.cancel();
		throw new IntegrationError('AVATAR_UNAVAILABLE', 'Initial Discord avatar unavailable', true);
	}
	const reader = response.body.getReader();
	// 按读取字节数限制导入大小，避免依赖远端声明的内容长度。
	const chunks: Array<Uint8Array> = [];
	let size = 0;
	try {
		while (true) {
			const {value, done} = await reader.read();
			if (done) break;
			size += value.length;
			if (size > 2 * 1024 * 1024) throw new IntegrationError('INVALID_REQUEST', 'Discord avatar exceeds import limit');
			chunks.push(value);
		}
	} finally {
		await reader.cancel();
	}
	const assets = getEntityAssetService();
	const prepared = await assets.prepareAssetUpload({
		assetType: 'avatar',
		entityType: 'user',
		entityId: binding.user_id,
		previousHash: null,
		base64Image: `data:${contentType};base64,${Buffer.concat(chunks).toString('base64')}`,
		errorPath: 'avatar_url',
	});
	await assets.commitAssetChange(prepared);
	return prepared.newHash;
}
