import { afterEach, describe, it } from 'vitest';
import { createFutureHarness, type FutureHarness } from './harness.js';
import { relationshipResolution } from './scenarios/relationship-resolution.js';
import { preferenceChange, projectContinuity } from './scenarios/continuity.js';

/**
 * PR8 — full long-horizon scenarios beyond the commitment slim harness:
 * relationship resolution leak, preference change, project continuity.
 * Visual continuity is covered by test/daily-visual-continuity-integration
 * with the same deterministic-clock discipline.
 */
let h: FutureHarness;
afterEach(async () => {
  if (h) await h.raw.cleanup();
});

describe('long-horizon: continuity scenarios', () => {
  it('a resolved relationship thread never leaks back (Day 10)', async () => {
    h = await createFutureHarness(undefined, { RELATIONSHIP_CONTEXT_ENABLED: 'true' });
    await relationshipResolution(h);
  });

  it('a changed preference replaces the old fact but keeps its history', async () => {
    h = await createFutureHarness();
    await preferenceChange(h);
  });

  it('a finished project stops being "ongoing" while staying recallable', async () => {
    h = await createFutureHarness();
    await projectContinuity(h);
  });
});
