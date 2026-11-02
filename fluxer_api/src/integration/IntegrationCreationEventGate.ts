// SPDX-License-Identifier: AGPL-3.0-or-later

import {IntegrationOperationRepository} from '@app/integration/IntegrationOperationRepository';

export class IntegrationCreationEventGate {
	/** 只有已持久完成的原生创建能够成为可见内容，暂态回滚不产生删除作品事件 */
	async status(operationId: string, threadId: string): Promise<'pending' | 'ready' | 'failed'> {
		const operation = await new IntegrationOperationRepository().find(operationId);
		if (!operation?.result) return 'pending';
		const result = JSON.parse(operation.result) as Record<string, unknown>;
		if (result.__integration_error) return 'failed';
		const saved = JSON.parse(operation.payload) as {operation_plan?: {thread_id?: string}; thread_id?: string};
		const plannedId = saved.operation_plan?.thread_id ?? saved.thread_id;
		if (plannedId !== threadId || result.thread_id !== threadId || result.message_id !== threadId) {
			throw new Error('Completed integration creation does not match the tracked native thread');
		}
		return 'ready';
	}
}
