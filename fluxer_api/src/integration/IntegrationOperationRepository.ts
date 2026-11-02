// SPDX-License-Identifier: AGPL-3.0-or-later

import {IntegrationError} from '@app/integration/IntegrationError';
import {INTEGRATION_QUERY_OPTIONS} from '@app/integration/IntegrationIdentityRepository';
import {getClient} from '@pkgs/cassandra/src/Client';

export interface IntegrationOperation {
	/** 永久占用的幂等操作标识 */
	operation_id: string;

	/** 不可变请求摘要 */
	fingerprint: string;

	/** 已鉴权的原生操作人 */
	actor_id: bigint;

	/** 不含凭据的恢复上下文 */
	payload: string;

	/** 已完成的操作结果 */
	result: string | null;
}

export class IntegrationOperationRepository {
	/** 在共用日志中保留资源占用，失败只允许同一操作恢复 */
	async lockResource(resource: string, operationId: string): Promise<void> {
		const id = `resource:${resource}`;
		await getClient().execute(
			'UPDATE integration_operations SET resource_owner = ? WHERE operation_id = ? IF resource_owner = null',
			[operationId, id],
			INTEGRATION_QUERY_OPTIONS,
		);
		const response = await getClient().execute(
			'SELECT resource_owner FROM integration_operations WHERE operation_id = ?',
			[id],
			INTEGRATION_QUERY_OPTIONS,
		);
		if (response.first()?.resource_owner !== operationId)
			throw new IntegrationError('RESOURCE_BUSY', 'An unfinished operation owns this resource', true);
	}

	/** 只有原持有者可以在结果持久化后释放资源 */
	async releaseResource(resource: string, operationId: string): Promise<void> {
		await getClient().execute(
			'UPDATE integration_operations SET resource_owner = null WHERE operation_id = ? IF resource_owner = ?',
			[`resource:${resource}`, operationId],
			INTEGRATION_QUERY_OPTIONS,
		);
	}
	/** 按幂等标识读取恢复上下文 */
	async find(id: string): Promise<IntegrationOperation | null> {
		const response = await getClient().execute(
			'SELECT * FROM integration_operations WHERE operation_id = ?',
			[id],
			INTEGRATION_QUERY_OPTIONS,
		);
		return response.first() as unknown as IntegrationOperation | null;
	}

	/** 先持久化授权上下文，再执行可恢复的业务步骤 */
	async allocate(record: IntegrationOperation): Promise<IntegrationOperation> {
		await getClient().execute(
			'INSERT INTO integration_operations (operation_id, fingerprint, actor_id, payload) VALUES (?, ?, ?, ?) IF NOT EXISTS',
			[record.operation_id, record.fingerprint, record.actor_id, record.payload],
			INTEGRATION_QUERY_OPTIONS,
		);
		const stored = await this.find(record.operation_id);
		if (!stored || stored.fingerprint !== record.fingerprint || stored.actor_id !== record.actor_id)
			throw new IntegrationError('OPERATION_CONFLICT', 'Operation belongs to a different request');
		return stored;
	}

	/** 永久保留结果，防止重试再次执行已完成的操作 */
	async complete(id: string, result: unknown): Promise<void> {
		await getClient().execute(
			'UPDATE integration_operations SET result = ? WHERE operation_id = ?',
			[JSON.stringify(result), id],
			INTEGRATION_QUERY_OPTIONS,
		);
	}

	/** 并发恢复只接受首个已持久处理结果，避免附件编号在租约交接时被改写 */
	async completeOnce(id: string, result: unknown): Promise<unknown> {
		await getClient().execute(
			'UPDATE integration_operations SET result = ? WHERE operation_id = ? IF result = null',
			[JSON.stringify(result), id],
			INTEGRATION_QUERY_OPTIONS,
		);
		const stored = await this.find(id);
		if (!stored?.result)
			throw new IntegrationError('STORAGE_UNAVAILABLE', 'Prepared operation result is unavailable', true);
		return JSON.parse(stored.result);
	}
}
