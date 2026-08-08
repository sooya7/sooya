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
    // Test files use isolated temp DATA_DIR/CONFIG_DIR databases, so they do not
    // need to queue behind one global worker. Keep cases inside each file serial
    // for deterministic lifecycle/race coverage, while parallelising independent
    // files across the hosted runner.
    fileParallelism: true,
    maxWorkers: 4,
    minWorkers: 1,
    reporters: ['default'],
    sequence: { concurrent: false }
  }
});
