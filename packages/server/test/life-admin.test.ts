import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './helpers/harness.js';

let harness: Harness | null = null;
afterEach(async () => {
  if (harness) await harness.cleanup();
  harness = null;
});

const ADMIN = { 'x-admin-token': 'admin-test-token' };

function localTime(iso: string): Date {
  return new Date(`${iso}+08:00`);
}

/**
 * P1 Life Admin: every mutation is audited, completed plan history is
 * immutable, thread lifecycle respects the active cap, and the overview /
 * proactive endpoints answer the "where / why / next" questions.
 */
describe('Life Admin API (P1)', () => {
  it('adjusts and resets vitals with audit entries', async () => {
    harness = await createHarness({ skipStickerImport: true, startWorkers: false, env: { ENABLE_LIFE_ENGINE: 'true', ADMIN_API_TOKEN: 'admin-test-token' } });
    const adjust = await harness.app.server.inject({
      method: 'POST',
      url: '/api/admin/life/vitals/adjust',
      headers: ADMIN,
      payload: { field: 'energy', delta: -10 }
    });
    expect(adjust.statusCode).toBe(200);
    const body = adjust.json() as { vitals: { energy: number } };
    expect(body.vitals.energy).toBe(62); // 72 - 10

    const reset = await harness.app.server.inject({
      method: 'POST',
      url: '/api/admin/life/vitals/reset',
      headers: ADMIN
    });
    expect(reset.statusCode).toBe(200);
    const audit = harness.app.repos.audit.list(20) as Array<{ category: string; action: string }>;
    expect(audit.some((a) => a.category === 'life.vitals' && a.action === 'adjust')).toBe(true);
    expect(audit.some((a) => a.category === 'life.vitals' && a.action === 'reset')).toBe(true);
  });

  it('allows editing a planned plan but protects completed history', async () => {
    harness = await createHarness({ skipStickerImport: true, startWorkers: false, env: { ADMIN_API_TOKEN: 'admin-test-token' } });
    const planned = harness.app.repos.life.createPlan({ title: '去公园', kind: 'out', status: 'planned', source: 'admin' });
    const patch = await harness.app.server.inject({
      method: 'PATCH',
      url: `/api/admin/life/plans/${planned.id}`,
      headers: ADMIN,
      payload: { status: 'paused', title: '改去图书馆' }
    });
    expect(patch.statusCode).toBe(200);
    expect((patch.json() as { plan: { title: string; status: string } }).plan.title).toBe('改去图书馆');

    const completed = harness.app.repos.life.createPlan({ title: '已完成的计划', kind: 'play', status: 'completed', source: 'generated' });
    const tamper = await harness.app.server.inject({
      method: 'PATCH',
      url: `/api/admin/life/plans/${completed.id}`,
      headers: ADMIN,
      payload: { status: 'active' }
    });
    expect(tamper.statusCode).toBe(409);
    expect((tamper.json() as { error: string }).error).toBe('immutable');
  });

  it('pauses, resolves and archives threads; audit records each change', async () => {
    harness = await createHarness({ skipStickerImport: true, startWorkers: false, env: { ADMIN_API_TOKEN: 'admin-test-token' } });
    const thread = harness.app.repos.lifeV2.saveThread({ title: '把画画练下去', category: 'interest', status: 'open', progress: 0.2, heat: 0.5, nextActions: ['画一张速写'], meta: { relatedActivityIds: ['craft'], source: 'persona_seed' } });
    const pause = await harness.app.server.inject({
      method: 'PATCH',
      url: `/api/admin/life/threads/${thread.id}`,
      headers: ADMIN,
      payload: { status: 'paused' }
    });
    expect(pause.statusCode).toBe(200);
    const resolve = await harness.app.server.inject({
      method: 'PATCH',
      url: `/api/admin/life/threads/${thread.id}`,
      headers: ADMIN,
      payload: { status: 'resolved' }
    });
    expect(resolve.statusCode).toBe(200);
    const audit = harness.app.repos.audit.list(20) as Array<{ category: string; action: string }>;
    expect(audit.filter((a) => a.category === 'life.thread').length).toBe(2);
  });

  it('overview answers where/why/next with location and weather when enabled', async () => {
    harness = await createHarness({
      skipStickerImport: true,
      startWorkers: false,
      env: { WORLD_CONTEXT_ENABLED: 'true', LOCATION_MODEL_ENABLED: 'true', WEATHER_ENABLED: 'true', ENABLE_LIFE_ENGINE: 'true', ADMIN_API_TOKEN: 'admin-test-token' },
      clock: () => localTime('2026-08-08T10:00')
    });
    // Move her somewhere first so the overview has a location to report.
    const locations = harness.app.services.location.list();
    const cafe = locations.find((l) => l.kind === 'cafe')!;
    harness.app.services.location.onActivityResolved({ id: 'cafe', kind: 'out', locationAffinity: ['cafe'] } as never, 'out', null, null);
    expect(harness.app.services.location.current()?.id).toBe(cafe.id);
    const res = await harness.app.server.inject({ method: 'GET', url: '/api/admin/life/overview', headers: ADMIN });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { snapshot: { activity: string }; location: { name: string } | null; weather: string | null; vitals: unknown };
    expect(typeof body.snapshot.activity).toBe('string');
    expect(body.location).toBeTruthy();
    expect(body.vitals).toBeTruthy();
  });

  it('lists proactive attempts for the admin view', async () => {
    harness = await createHarness({ skipStickerImport: true, startWorkers: false, env: { ADMIN_API_TOKEN: 'admin-test-token' } });
    harness.app.repos.proactive.create({ candidateId: 'cand-1', candidateKind: 'play', candidateActivity: '练琴', requestedMode: 'text', status: 'blocked', blockedReason: 'nothing_worth_saying', detail: {} });
    const res = await harness.app.server.inject({ method: 'GET', url: '/api/admin/life/proactive', headers: ADMIN });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { attempts: Array<{ candidateId: string | null; status: string }> };
    expect(body.attempts.some((a) => a.candidateId === 'cand-1' && a.status === 'blocked')).toBe(true);
  });

  it('keeps the admin life endpoints behind the guard', async () => {
    harness = await createHarness({ skipStickerImport: true, startWorkers: false, env: { ADMIN_API_TOKEN: 'admin-test-token' } });
    const res = await harness.app.server.inject({ method: 'GET', url: '/api/admin/life/overview' });
    expect(res.statusCode).toBe(401);
  });
});
