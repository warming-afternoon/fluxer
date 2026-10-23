// SPDX-License-Identifier: AGPL-3.0-or-later

export type RateLimitScope = 'global' | 'shared' | 'user';
export interface RateLimitResult {
	allowed: boolean;
	limit: number;
	remaining: number;
	resetTime: Date;
	resetAfterDecimal: number;
	retryAfter?: number;
	retryAfterDecimal?: number;
	global?: boolean;
}

/** 向中间件提供同一次全局与路由限流判断。 */
export interface GlobalAndBucketLimitResult {
	/** 全局额度及拒绝信息。 */
	global: RateLimitResult;

	/** 仅在全局允许后产生的路由额度。 */
	bucket?: RateLimitResult;
}

export interface RateLimitConfig {
	maxAttempts: number;
	windowMs: number;
	identifier: string;
}

export interface BucketConfig {
	limit: number;
	windowMs: number;
	exemptFromGlobal?: boolean;
}

export interface IRateLimitService {
	checkLimit(config: RateLimitConfig): Promise<RateLimitResult>;
	peekLimit(config: RateLimitConfig): Promise<RateLimitResult>;
	checkBucketLimit(bucket: string, config: BucketConfig): Promise<RateLimitResult>;
	/** 保持原有扣额顺序，允许存储层合并单节点往返。 */
	checkGlobalAndBucketLimit?(
		identifier: string,
		globalLimit: number,
		bucket: string,
		config: BucketConfig,
	): Promise<GlobalAndBucketLimitResult>;
	checkGlobalLimit(identifier: string, limit: number): Promise<RateLimitResult>;
	resetLimit(identifier: string): Promise<void>;
	clearLimitsByIdentifierPrefix(identifierPrefix: string): Promise<number>;
}
