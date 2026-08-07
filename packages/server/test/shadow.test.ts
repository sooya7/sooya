import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './helpers/harness.js';

let harness: Harness | null = null;
afterEach(async () => {
  if (harness) await harness.cleanup();
  harness = null;
});

function localTime(iso: string): Date {
  return new Date(`${iso}+08:00`);
}

const SHADOW_ENV = {
  SHADOW_MODE_ENABLED: 'true',
  WORLD_CONTEXT_ENABLED: 'true',
  LOCATION_MODEL_ENABLED: 'true',
  WEATHER_ENABLED: 'true',
  ENABLE_LIFE_ENGINE: 'true'
};

/**
 * P3 shadow runtime: sampling is read-only by construction. The shadow never
 * changes a canonical decision, never writes outside shadow_runs, and its
 * failures never reach the caller. Flag off = zero rows.
 */
describe('shadow runtime (P3)', () => {
  it('records nothing when SHADOW_MODE_ENABLED is off', async () => {
    harness = await createHarness({ skipStickerImport: true, startWorkers: false });
    harness.app.services.life.tick();
    harness.app.services.location.onActivityResolved({ id: 'cafe', kind: 'out', locationAffinity: ['cafe'] } as never, 'out', null, null);
    expect(harness.app.repos.shadow.list()).toEqual([]);
  });

  it('shadow-on run keeps the canonical decision identical and only adds shadow_runs rows', async () => {
    // Two identical harnesses: the only difference is the shadow flag. The
    // canonical activity must come out exactly the same (location ids are
    // random per harness and only affect hash tie-breaks, so locations are
    // compared within a single harness instead).
    const make = (shadowOn: boolean) => createHarness({
      skipStickerImport: true,
      startWorkers: false,
      env: { ...SHADOW_ENV, ...(shadowOn ? {} : { SHADOW_MODE_ENABLED: 'false' }) },
      clock: () => localTime('2026-08-08T10:00')
    });
    const plain = await make(false);
    const plainResult = plain.app.services.life.tick();
    expect(plain.app.repos.shadow.list()).toEqual([]);
    await plain.cleanup();

    harness = await make(true);
    const result = harness.app.services.life.tick();

    // Canonical behavior is identical with the flag on.
    expect(result.activity).toBe(plainResult.activity);
    expect(result.kind).toBe(plainResult.kind);
    const state = harness.app.services.location.currentState();
    expect(state).toBeTruthy();

    // The only difference: shadow runs were recorded.
    const runs = harness.app.repos.shadow.list();
    expect(runs.length).toBeGreaterThanOrEqual(1);
    const run = runs.find((r) => r.subsystem === 'life.activity_selector')!;
    expect(run.canonical_version).toBe('canonical');
    expect(run.shadow_version).toBe('cont1.5-tight48');
    // Decisions are fingerprints of activity ids; no free text inside.
    expect(run.input_fingerprint).toMatch(/^[0-9a-f]{24}$/);
    const canonical = JSON.parse(run.canonical_decision) as { best: string | null };
    expect(canonical.best).toBeTruthy();
  });

  it('samples the location selector through the canonical move only', async () => {
    harness = await createHarness({
      skipStickerImport: true,
      startWorkers: false,
      env: SHADOW_ENV,
      clock: () => localTime('2026-08-08T10:00')
    });
    const before = harness.app.services.location.current();
    harness.app.services.location.onActivityResolved({ id: 'cafe', kind: 'out', locationAffinity: ['cafe'] } as never, 'out', 'plan_1', null);
    const runs = harness.app.repos.shadow.list();
    const run = runs.find((r) => r.subsystem === 'life.location_selector')!;
    expect(run).toBeTruthy();
    expect(run.shadow_version).toBe('weather-off');
    // The move itself is the canonical path (audited, with plan attribution);
    // the shadow only recorded the diff row.
    const state = harness.app.services.location.currentState();
    expect(before?.id).not.toBe(state?.location_id);
    expect(state?.source_plan_id).toBe('plan_1');
    expect(harness.app.repos.shadow.list().filter((r) => r.subsystem !== 'life.location_selector')).toHaveLength(0);
  });

  it('a failing shadow function never throws into the canonical path', async () => {
    harness = await createHarness({ skipStickerImport: true, startWorkers: false });
    const shadow = harness.app.services.shadow;
    shadow.setEnabled(true);
    expect(() =>
      shadow.run({
        subsystem: 'test.selector',
        canonicalVersion: 'canonical',
        shadowVersion: 'explode',
        input: { x: 1 },
        canonicalDecision: { pick: 'a' },
        runShadow: () => { throw new Error('shadow boom'); }
      })
    ).not.toThrow();
    // The failed shadow left no trace; canonical path was unaffected.
    expect(harness.app.repos.shadow.list()).toEqual([]);
    shadow.setEnabled(false);
  });

  it('exposes recent runs through the admin endpoint with the token', async () => {
    harness = await createHarness({
      skipStickerImport: true,
      startWorkers: false,
      env: { ...SHADOW_ENV, ADMIN_API_TOKEN: 'shadow-test-token' }
    });
    harness.app.services.location.onActivityResolved({ id: 'cafe', kind: 'out', locationAffinity: ['cafe'] } as never, 'out', null, null);
    const res = await harness.app.server.inject({
      method: 'GET',
      url: '/api/admin/shadow-runs?limit=10',
      headers: { 'x-admin-token': 'shadow-test-token' }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { runs: Array<{ subsystem: string; shadow_version: string }> };
    expect(body.runs.length).toBeGreaterThanOrEqual(1);
    expect(body.runs.some((r) => r.subsystem === 'life.location_selector')).toBe(true);
  });
});
