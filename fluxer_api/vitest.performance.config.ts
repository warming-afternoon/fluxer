// SPDX-License-Identifier: AGPL-3.0-or-later

import {fileURLToPath} from 'node:url';
import {defineConfig} from 'vitest/config';

export default defineConfig({
 resolve: {tsconfigPaths: true, alias: {'@app': fileURLToPath(new URL('./src', import.meta.url)), '@pkgs': fileURLToPath(new URL('./pkgs', import.meta.url))}},
 test: {include: ['../tools/benchmark/PostgresQueryPlans.integration.test.ts'], environment: 'node', maxWorkers: 1, maxConcurrency: 1, fileParallelism: false, testTimeout: 40000, hookTimeout: 120000},
});
