// SPDX-License-Identifier: AGPL-3.0-or-later

import {DEFAULT_KV_TIMEOUT_MS} from '@fluxer/constants/src/Timeouts';

export interface IKVLogger {
	debug(obj: object, msg?: string): void;
	error(obj: object, msg?: string): void;
}

export type KVClientMode = 'standalone' | 'cluster';

export interface KVClientConfig {
	url: string;
	mode?: KVClientMode;
	timeoutMs?: number;
	/** 是否在断线期间暂存命令；默认沿用客户端行为。 */
	enableOfflineQueue?: boolean;
	logger?: IKVLogger;
}

export interface ResolvedKVClientConfig {
	url: string;
	mode: KVClientMode;
	timeoutMs: number;
	/** 仅在调用方显式指定时覆盖离线队列行为。 */
	enableOfflineQueue?: boolean;
	logger: IKVLogger;
}

const noopLogger: IKVLogger = {
	debug() {},
	error() {},
};

export function resolveKVClientConfig(config: KVClientConfig | string): ResolvedKVClientConfig {
	const options: KVClientConfig = typeof config === 'string' ? {url: config} : config;
	return {
		url: normalizeUrl(options.url),
		mode: options.mode ?? 'standalone',
		timeoutMs: options.timeoutMs ?? DEFAULT_KV_TIMEOUT_MS,
		logger: options.logger ?? noopLogger,
		...(options.enableOfflineQueue === undefined ? {} : {enableOfflineQueue: options.enableOfflineQueue}),
	};
}

function normalizeUrl(url: string): string {
	const trimmed = url.trim();
	if (trimmed.length === 0) {
		throw new Error('KV client URL must not be empty');
	}
	const query = new URLSearchParams(trimmed.match(/^[^?#]*(\?[^#]*)/)?.[1]);
	if (query.has('stringNumbers')) {
		throw new Error('KV client URLs do not support stringNumbers; numeric replies are required');
	}
	return trimmed;
}
