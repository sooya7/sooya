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

  it('status=shadow 时 canonical 决策与无实验完全一致（byte-equivalent）', async () => {
    // 两个 harness 的唯一差异：B 存在一个 status=shadow 的实验。
    // 修复前 variantForSubsystem 在 shadow 状态会给 canonical 返回实验变体
    // （bug）；修复后 canonicalVariantForSubsystem 永远 'control'，
    // 因此 canonical 决策必须字节级一致。
    const make = () => createHarness({
      skipStickerImport: true,
      startWorkers: false,
      env: { ...SHADOW_ENV, EXPERIMENTS_ENABLED: 'true' },
      clock: () => localTime('2026-08-08T10:00')
    });
    const plain = await make();
    const plainResult = plain.app.services.life.tick();
    await plain.cleanup();

    harness = await make();
    const experiments = harness.app.services.experiments;
    const created = experiments.create('连续性权重', 'life.continuity_weight', ['x1', 'x1.5'], 'day');
    expect(experiments.setStatus(created.id, 'shadow').ok).toBe(true);

    // Canonical 隔离：canonical 永远 'control'；shadow 采样才拿实验变体。
    expect(experiments.canonicalVariantForSubsystem('life.continuity_weight')).toBe('control');
    expect(experiments.variantForSubsystem('life.continuity_weight')).toBe('control');
    const sampled = experiments.shadowVariantForSubsystem('life.continuity_weight');
    expect(['x1', 'x1.5']).toContain(sampled);

    const result = harness.app.services.life.tick();
    // 字节级一致：整个 tick 结果 JSON 完全相等。
    expect(JSON.stringify(result)).toBe(JSON.stringify(plainResult));
    // 同时直接对比 engine 消费点（canonical 变体消费）的取值。
    expect(experiments.canonicalVariantFor(created.id)).toBe('control');
  });
});
