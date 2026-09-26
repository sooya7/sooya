import { createHash } from 'node:crypto';
import { test as base } from '@playwright/test';

export { expect } from '@playwright/test';

/**
 * Every test acts as its own client.
 *
 * The server rate-limits /api/admin at 240 requests per minute per client
 * (util/rate-limit.ts), keyed on req.ip. The whole suite runs from 127.0.0.1,
 * and a few specs walk all thirteen console pages at several viewports, so
 * sharing one bucket made later tests fail with `rate_limited`. The server
 * trusts X-Forwarded-For from loopback by default (TRUST_PROXY=loopback), so
 * each test sends its own stable address and gets its own budget. A single
 * test that floods the API still trips the limiter, which is worth knowing.
 */
export const test = base.extend({
  extraHTTPHeaders: async ({ extraHTTPHeaders }, use, testInfo) => {
    const digest = createHash('sha1').update(`${testInfo.testId}#${testInfo.retry}#${testInfo.repeatEachIndex}`).digest();
    const address = `10.${digest[0]}.${digest[1]}.${(digest[2]! % 250) + 2}`;
    await use({ ...extraHTTPHeaders, 'x-forwarded-for': address });
  }
});
