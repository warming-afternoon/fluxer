// SPDX-License-Identifier: AGPL-3.0-or-later

import {describe, expect, it, vi} from 'vitest';

vi.hoisted(() => {
	vi.resetModules();
});
const find = vi.hoisted(() => vi.fn());
vi.mock('@app/integration/IntegrationOperationRepository', () => ({
	IntegrationOperationRepository: class {
		find = find;
	},
}));

import {IntegrationCreationEventGate} from '@app/integration/IntegrationCreationEventGate';

describe('persisted creation completion gate', () => {
	it('waits for persisted success and rejects terminal failure or mismatched native IDs', async () => {
		const gate = new IntegrationCreationEventGate();
		find.mockResolvedValue({result: null});
		expect(await gate.status('op', '33')).toBe('pending');
		find.mockResolvedValue({result: JSON.stringify({__integration_error: {code: 'FORBIDDEN'}})});
		expect(await gate.status('op', '33')).toBe('failed');
		find.mockResolvedValue({
			payload: JSON.stringify({operation_plan: {thread_id: '33'}}),
			result: JSON.stringify({thread_id: '33', message_id: '33'}),
		});
		expect(await gate.status('op', '33')).toBe('ready');
		await expect(gate.status('op', '44')).rejects.toThrow('does not match');
	});
});
