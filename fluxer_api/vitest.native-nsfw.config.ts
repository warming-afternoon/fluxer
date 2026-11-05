import {defineConfig} from 'vitest/config';
export default defineConfig({
	resolve: {tsconfigPaths: true},
	test: {environment: 'node', include: ['tests/NsfwVisibilitySettings.test.ts'], maxWorkers: 1},
});
