import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './helpers/harness.js';

let harness: Harness | null = null;

afterEach(async () => {
  if (harness) await harness.cleanup();
  harness = null;
});

function entry(index: number, overrides: Record<string, unknown> = {}) {
  return {
    kind: 'fact' as const,
    subject: `import-subject-${index}`,
    predicate: 'status',
    object: `value-${index}`,
    confidence: 0.8,
    authority: 'admin' as const,
    ...overrides
  };
}

describe('world import transaction and scale', () => {
  it('rolls back every imported entry when a later database write fails', async () => {
    harness = await createHarness();
    harness.app.db.prepare(`
      CREATE TRIGGER abort_world_import
      BEFORE INSERT ON world_entries
      WHEN NEW.subject = 'ROLLBACK_SENTINEL'
      BEGIN
        SELECT RAISE(ABORT, 'forced world import failure');
      END
    `).run();

    expect(() => harness!.app.services.world.import({
      version: 1,
      entries: [
        entry(1),
        entry(2, { subject: 'ROLLBACK_SENTINEL' }),
        entry(3)
      ]
    })).toThrow(/forced world import failure/);

    expect(harness.app.repos.world.count()).toBe(0);
  });

  it('imports 2000 entries in one bounded operation and reports all results', async () => {
    harness = await createHarness();
    const startedAt = performance.now();
    const result = harness.app.services.world.import({
      version: 1,
      entries: Array.from({ length: 2000 }, (_, index) => entry(index))
    });
    const elapsedMs = performance.now() - startedAt;

    expect(result).toEqual({ stored: 2000, merged: 0, conflicts: 0, disabled: 0 });
    expect(harness.app.repos.world.count()).toBe(2000);
    expect(elapsedMs).toBeLessThan(10_000);
  }, 15_000);

  it('returns deterministic merge, conflict, and disabled counts', async () => {
    harness = await createHarness();
    const result = harness.app.services.world.import({
      version: 1,
      entries: [
        entry(1, { subject: 'shared', object: 'first', authority: 'user' }),
        entry(2, { subject: 'shared', object: 'first', authority: 'admin' }),
        entry(3, { subject: 'shared', object: 'replacement', authority: 'model' }),
        entry(4, { active: false })
      ]
    });

    expect(result).toEqual({ stored: 2, merged: 1, conflicts: 1, disabled: 1 });
    expect(harness.app.repos.world.count(true)).toBe(1);
    expect(harness.app.repos.world.count(false)).toBe(2);
  });
});
