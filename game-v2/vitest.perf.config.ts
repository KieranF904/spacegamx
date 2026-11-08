import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config';

/** npm run test:perf: only the *.perf.test.ts files (timings logged, microbenches), kept out of the default run */
const merged = mergeConfig(base, defineConfig({ test: { env: { POWER_BENCH: '1' } } }));
// mergeConfig concatenates arrays: set the file lists outright
merged.test!.include = ['common/src/**/*.perf.test.ts', 'client/src/**/*.perf.test.ts', 'server/src/**/*.perf.test.ts'];
merged.test!.exclude = ['**/node_modules/**'];
export default merged;
