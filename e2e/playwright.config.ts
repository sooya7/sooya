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
 * QQ 单通道后（docs/QQ-BOT-SINGLE-CHANNEL-PLAN.md §13/§14）：Web 只保留
 * Admin / Gallery，普通聊天与 PWA 已下线。该套件启动一个真实 SOOYA server
 * （built server + built web client）+ 本地 OpenAI-compatible mock model，
 * 只覆盖仍然存在的浏览器界面（管理后台 / 图库）；QQ 消息链路由
 * server 集成测试（packages/server/test/qq-*.test.ts）覆盖，不在浏览器里测。
 *
 * General product behaviour runs once on desktop. Responsive coverage has its
 * own mobile contract in mobile-admin-ux.e2e.ts, while theme.e2e.ts explicitly
 * walks phone, landscape and desktop viewports itself. Running every business
 * flow again under Pixel 7 doubled CI time without adding a distinct contract.
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
  forbidOnly: Boolean(process.env.CI),
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
    {
      name: 'desktop',
      testIgnore: 'mobile-admin-ux.e2e.ts',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 860 } }
    },
    {
      name: 'mobile',
      testMatch: 'mobile-admin-ux.e2e.ts',
      use: { ...devices['Pixel 7'] }
    }
  ]
});
