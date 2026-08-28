import { afterEach, describe, expect, it } from 'vitest';
import { createFutureHarness, type FutureHarness } from './harness.js';
import { boundaryDates, retryIdempotency } from './scenarios/commitment-boundary.js';
import { commitmentLifecycle, unattendedLifecycle } from './scenarios/commitment-lifecycle.js';
import { contextDedupe } from './scenarios/context-dedupe.js';
import { resolveVisualTime } from '../../src/core/visual-time.js';

/**
 * PR4 — Commitment Slim Harness: turns the first-stage validation list
 * (§43) into repeatable assertions instead of eyeballing production.
 */
let h: FutureHarness;
afterEach(async () => {
  if (h) await h.raw.cleanup();
});

describe('long-horizon: commitment slim harness', () => {
  it('extracts, dedupes, reschedules, completes and forgets an exam', async () => {
    h = await createFutureHarness();
    await commitmentLifecycle(h);
  });

  it('runs the unattended §13 lifecycle (missed / expired / archived)', async () => {
    h = await createFutureHarness();
    await unattendedLifecycle(h);
  });

  it('resolves boundary dates deterministically across local midnight', async () => {
    h = await createFutureHarness();
    await boundaryDates(h);
  });

  it('never double-writes a retried post-turn analysis', async () => {
    h = await createFutureHarness();
    await retryIdempotency(h);
  });

  it('states a current fact once across memory and future context (§10.4)', async () => {
    h = await createFutureHarness();
    await contextDedupe(h);
  });

  it('keeps everything dark when the engine flag is off', async () => {
    // Defaults are now enabled. This assertion protects the explicit kill
    // switch instead of relying on the historical default-off behavior.
    const { createHarness } = await import('../helpers/harness.js');
    const plain = await createHarness({
      embedding: 'off',
      env: { FUTURE_ENGINE_ENABLED: 'false' }
    });
    try {
      plain.app.repos.commitments.ingest({
        kind: 'user_event',
        subject: 'user',
        title: '考试',
        dueAt: new Date(Date.now() + 86_400_000).toISOString(),
        timePrecision: 'day',
        sourceMessageId: 'seed'
      });
      const built = await plain.app.services.context.build(plain.app.config.getPersona(), '你好', {
        recentMessages: 10,
        memoryLimit: 8,
        allowVision: false,
        stickerCatalogue: '',
        voiceMoods: '',
        capabilityNotes: [],
        contextWindow: 8_000,
        maxOutputTokens: 1_000,
        visualTime: resolveVisualTime({ now: '2026-08-26T05:17:23.000Z' })
      });
      expect(built.system).not.toContain('接下来值得记得的事情');
    } finally {
      await plain.cleanup();
    }
  });
});
