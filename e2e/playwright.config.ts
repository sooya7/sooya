import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * Resolve every path against THIS file.
 *
 * The repository root re-exports this config, and Playwright resolves relative
 * entries (testDir, globalSetup, ...) against the config file it was handed.
 * A relative './global-setup.ts' therefore pointed at the repository root when
 * the suite was started through `npm run test:e2e`, and the run died before a
 * single spec executed.
 *
 * `__dirname` is used rather than `import.meta.url` because Playwright may load
 * this file through its CommonJS transform (the repository root has no
 * "type":"module"), where `import.meta` is unavailable.
 */
const HERE = __dirname;

/**
 * Browser end-to-end tests.
 *
 * The suite boots a real SOOYA server (built server + built web client) backed
 * by a local OpenAI-compatible mock model, so streaming, media files, SSE and
 * the PWA are exercised over real HTTP — not mocked in the page.
 */
const PORT = Number(process.env.E2E_PORT ?? 8790);

export default defineConfig({
  testDir: HERE,
  testMatch: '*.e2e.ts',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  globalSetup: path.join(HERE, 'global-setup.ts'),
  globalTeardown: path.join(HERE, 'global-teardown.ts'),
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    permissions: ['microphone']
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 860 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } }
  ]
});
