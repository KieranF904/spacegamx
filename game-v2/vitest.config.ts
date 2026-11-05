import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@space-game/common': resolve(__dirname, 'common/src/index.ts'),
    },
  },
  test: {
    include: ['common/src/**/*.test.ts', 'server/src/**/*.test.ts', 'client/src/**/*.test.ts', 'server-browser/src/**/*.test.ts', 'site/src/**/*.test.ts', 'scripts/db/**/*.test.ts', 'scripts/shipgen/**/*.test.ts'],
    environment: 'node',
    // Each test builds whole game servers (every system loaded): the bigger files need more than the default heap
    // At most 3 workers (VITEST_MAX_FORKS overrides): the default of one per core starves the dev servers and the desktop
    poolOptions: { forks: { execArgv: ['--max-old-space-size=6144'], minForks: 1, maxForks: Number(process.env.VITEST_MAX_FORKS) || 3 } },
  },
});
