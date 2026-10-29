// SPDX-License-Identifier: AGPL-3.0-or-later

import {Config} from '@app/api/Config';
import * as ServiceRegistry from '@app/api/middleware/ServiceRegistry';
import {IntegrationIdentityRepository} from '@app/integration/IntegrationIdentityRepository';
import {startIntegrationMain} from '@app/integration/IntegrationMain';
import * as CassandraClient from '@pkgs/cassandra/src/Client';
import {afterEach, describe, expect, it, vi} from 'vitest';

describe('Integration startup cleanup', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	it('closes only initialized resources after Snowflake initialization fails', async () => {
		vi.stubEnv('INTEGRATION_NATS_URL', 'nats://integration.invalid:4222');
		vi.stubEnv('INTEGRATION_NATS_USER', 'integration');
		vi.stubEnv('INTEGRATION_NATS_PASSWORD', 'test');
		vi.stubEnv('INTEGRATION_EXCHANGE_KEY', 'a'.repeat(64));
		const originalBackend = Config.database.backend;
		Config.database.backend = 'cassandra';
		const init = vi.spyOn(CassandraClient, 'initCassandra').mockResolvedValue();
		const close = vi.spyOn(CassandraClient, 'shutdownCassandra').mockResolvedValue();
		const kvClose = vi.spyOn(ServiceRegistry, 'closeOwnedKVClient').mockImplementation(() => {});
		vi.spyOn(IntegrationIdentityRepository.prototype, 'checkHealth').mockResolvedValue();
		const shutdown = vi.fn().mockResolvedValue(undefined);
		vi.spyOn(ServiceRegistry, 'createSnowflakeService').mockReturnValue({
			initialize: vi.fn().mockRejectedValue(new Error('snowflake unavailable')),
			shutdown,
		} as unknown as ReturnType<typeof ServiceRegistry.createSnowflakeService>);
		try {
			await expect(startIntegrationMain()).rejects.toThrow('snowflake unavailable');
			expect(init).toHaveBeenCalledOnce();
			expect(shutdown).toHaveBeenCalledOnce();
			expect(close).toHaveBeenCalledOnce();
			expect(kvClose).toHaveBeenCalledOnce();
		} finally {
			Config.database.backend = originalBackend;
		}
	});

	it('rejects a missing encryption key before opening any resource', async () => {
		vi.stubEnv('INTEGRATION_EXCHANGE_KEY', '');
		const init = vi.spyOn(CassandraClient, 'initCassandra').mockResolvedValue();
		const originalBackend = Config.database.backend;
		Config.database.backend = 'cassandra';
		try {
			await expect(startIntegrationMain()).rejects.toThrow('INTEGRATION_EXCHANGE_KEY');
			expect(init).not.toHaveBeenCalled();
		} finally {
			Config.database.backend = originalBackend;
		}
	});
});
