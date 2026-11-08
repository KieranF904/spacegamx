import { configDefaults, defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@space-game/common': resolve(__dirname, 'common/src/index.ts'),
    },
  },
  test: {
    // Perf/bench files (*.perf.test.ts) run by npm run test:perf (vitest.perf.config.ts), not by default
    exclude: [...configDefaults.exclude, '**/*.perf.test.ts'],
    include: ['common/src/**/*.test.ts', 'server/src/**/*.test.ts', 'client/src/**/*.test.ts', 'server-browser/src/**/*.test.ts', 'site/src/**/*.test.ts', 'scripts/db/**/*.test.ts', 'scripts/contracts/**/*.test.ts', 'scripts/shipgen/**/*.test.ts'],
    environment: 'node',
    // The payout dice's secret fixed (server/src/game/payoutDice.ts): mining, loot and the like roll the same every run
    env: { PAYOUT_SECRET: 'tests' },
    // Each test builds whole game servers (every system loaded): the bigger files need more than the default heap
    // At most 3 workers (VITEST_MAX_FORKS overrides): the default of one per core starves the dev servers and the desktop
    poolOptions: { forks: { execArgv: ['--max-old-space-size=6144'], minForks: 1, maxForks: Number(process.env.VITEST_MAX_FORKS) || 3 } },
  },
});
