// SPDX-License-Identifier: AGPL-3.0-or-later

import {defineConfig} from 'vitest/config';

export default defineConfig({
	resolve: {tsconfigPaths: true},
	test: {
		include: ['src/api/database/CassandraMetadata.integration.test.ts'],
		environment: 'node',
		maxWorkers: 1,
		fileParallelism: false,
		testTimeout: 40000,
		hookTimeout: 120000,
	},
});
