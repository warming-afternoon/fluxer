// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID} from '@app/api/BrandedTypes';
import {type ExchangeRecord, IntegrationExchangeRepository} from '@app/integration/IntegrationExchangeRepository';
import * as CassandraClient from '@pkgs/cassandra/src/Client';
import type cassandra from 'cassandra-driver';
import {afterEach, describe, expect, it, vi} from 'vitest';

describe('Integration exchange persistence', () => {
	afterEach(() => vi.restoreAllMocks());
	it('encrypts results with operation-bound authentication and a ten-minute ciphertext TTL', async () => {
		const execute = vi.fn().mockResolvedValue({wasApplied: () => true});
		vi.spyOn(CassandraClient, 'getClient').mockReturnValue({execute} as unknown as cassandra.Client);
		const repository = new IntegrationExchangeRepository(Buffer.alloc(32, 7));
		const token = `flx_${'a'.repeat(36)}`;
		expect(await repository.begin('exchange_123456789', token)).toBe(true);
		const ciphertext = execute.mock.calls[0]![1][0] as string;
		expect(ciphertext).not.toContain(token);
		expect(execute.mock.calls[0]![0]).toContain('USING TTL 600');
		expect(execute.mock.calls[0]![0]).toContain("IF state = 'allocated'");
		const record: ExchangeRecord = {
			fingerprint: 'f',
			user_id: createUserID(123n),
			state: 'executing',
			encrypted_token: ciphertext,
			expires_at: new Date(Date.now() + 600_000),
		};
		expect(repository.decrypt('exchange_123456789', record)).toBe(token);
		expect(() => repository.decrypt('exchange_other1234', record)).toThrow();
		expect(() =>
			new IntegrationExchangeRepository(Buffer.alloc(32, 8)).decrypt('exchange_123456789', record),
		).toThrow();
		expect(() => repository.decrypt('exchange_123456789', {...record, expires_at: new Date(0)})).toThrow();
	});

	it('does not win a second execution attempt after a conditional claim was consumed', async () => {
		const execute = vi.fn().mockResolvedValue({wasApplied: () => false});
		vi.spyOn(CassandraClient, 'getClient').mockReturnValue({execute} as unknown as cassandra.Client);
		const repository = new IntegrationExchangeRepository(Buffer.alloc(32, 7));
		expect(await repository.begin('exchange_123456789', `flx_${'a'.repeat(36)}`)).toBe(false);
	});

	it('does not acknowledge success when completion was not persisted', async () => {
		const execute = vi
			.fn()
			.mockResolvedValueOnce({wasApplied: () => false})
			.mockResolvedValueOnce({first: () => ({state: 'executing', expires_at: new Date(Date.now() + 600_000)})});
		vi.spyOn(CassandraClient, 'getClient').mockReturnValue({execute} as unknown as cassandra.Client);
		const repository = new IntegrationExchangeRepository(Buffer.alloc(32, 7));
		await expect(repository.complete('exchange_123456789')).rejects.toMatchObject({
			code: 'EXCHANGE_UNCERTAIN',
			retryable: true,
		});
	});
});
