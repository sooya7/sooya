import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `src/**` was missing, so tests written next to their source — speakerPrefix's
    // among them — were silently never executed while ci stayed green.
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: 'forks',
    maxWorkers: 1,
    minWorkers: 1,
    reporters: ['default'],
    sequence: { concurrent: false }
  }
});
