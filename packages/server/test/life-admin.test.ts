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
    // Move her somewhere first so the overview has a location to report
    // (anti-teleport: the trip settles once expectedArriveAt passes).
    let now = localTime('2026-08-08T10:00');
    harness = await createHarness({
      skipStickerImport: true,
      startWorkers: false,
      env: { WORLD_CONTEXT_ENABLED: 'true', LOCATION_MODEL_ENABLED: 'true', WEATHER_ENABLED: 'true', ENABLE_LIFE_ENGINE: 'true', ADMIN_API_TOKEN: 'admin-test-token' },
      clock: () => now
    });
    const locations = harness.app.services.location.list();
    const cafe = locations.find((l) => l.kind === 'cafe')!;
    harness.app.services.location.onActivityResolved({ id: 'cafe', kind: 'out', locationAffinity: ['cafe'] } as never, 'out', null, null);
    now = localTime('2026-08-08T10:30');
    harness.app.services.location.current();
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

  it('creates cities with server-fixed country=中国 and LIFE_TIME_ZONE', async () => {
    harness = await createHarness({
      skipStickerImport: true,
      startWorkers: false,
      env: { WORLD_CONTEXT_ENABLED: 'true', LOCATION_MODEL_ENABLED: 'true', ADMIN_API_TOKEN: 'admin-test-token' }
    });
    const res = await harness.app.server.inject({
      method: 'POST',
      url: '/api/admin/life/cities',
      headers: ADMIN,
      payload: { name: '杭州', region: '浙江', country: '日本', timeZone: 'Asia/Tokyo' }
    });
    expect(res.statusCode).toBe(200);
    const city = (res.json() as { city: { name: string; country: string; region: string; timeZone: string } }).city;
    // 用户传入的国家/时区被忽略：服务端固定中国 + LIFE_TIME_ZONE。
    expect(city.country).toBe('中国');
    expect(city.region).toBe('浙江');
    expect(city.timeZone).toBe('Asia/Shanghai');
    expect(city.name).toBe('杭州');
  });

  it('PATCH active:true routes through the canonical setActiveCity switch', async () => {
    let at = localTime('2026-08-08T10:00');
    harness = await createHarness({
      skipStickerImport: true,
      startWorkers: false,
      env: { WORLD_CONTEXT_ENABLED: 'true', LOCATION_MODEL_ENABLED: 'true', WEATHER_ENABLED: 'true', ADMIN_API_TOKEN: 'admin-test-token' },
      clock: () => at
    });
    const service = harness.app.services.location;
    const ningbo = service.activeCity()!;
    expect(ningbo.name).toBe('宁波');
    // 造一个在途行程（防瞬移）。
    const cafe = service.list().find((l) => l.kind === 'cafe')!;
    service.onActivityResolved({ id: 'cafe', kind: 'out', locationAffinity: ['cafe'] } as never, 'out', null, null);
    expect(service.currentTravel()).toBeTruthy();

    const created = await harness.app.server.inject({
      method: 'POST',
      url: '/api/admin/life/cities',
      headers: ADMIN,
      payload: { name: '杭州', region: '浙江' }
    });
    const hangzhouId = (created.json() as { city: { id: string } }).city.id;

    const patched = await harness.app.server.inject({
      method: 'PATCH',
      url: `/api/admin/life/cities/${hangzhouId}`,
      headers: ADMIN,
      payload: { active: true }
    });
    expect(patched.statusCode).toBe(200);
    // canonical 切换语义：active=杭州、movement 清空、builtin 归属迁移、Weather 跟随。
    expect(service.activeCity()?.id).toBe(hangzhouId);
    expect(service.currentTravel()).toBeNull();
    const homeAfter = service.list().find((l) => l.key === 'home')!;
    expect(homeAfter.cityId).toBe(hangzhouId);
    expect(harness.app.services.world.weatherLocation()?.city).toBe('杭州');
    // 审计留痕。
    const audit = harness.app.repos.audit.list(20) as Array<{ category: string; action: string }>;
    expect(audit.some((a) => a.category === 'life.city' && a.action === 'activated')).toBe(true);
  });

  it('rejects active:false on city PATCH — city changes only via canonical switch', async () => {
    harness = await createHarness({
      skipStickerImport: true,
      startWorkers: false,
      env: { WORLD_CONTEXT_ENABLED: 'true', LOCATION_MODEL_ENABLED: 'true', ADMIN_API_TOKEN: 'admin-test-token' }
    });
    const cities = await harness.app.server.inject({
      method: 'GET',
      url: '/api/admin/life/cities',
      headers: ADMIN
    });
    const ningboId = (cities.json() as { cities: Array<{ id: string }> }).cities[0]!.id;
    const res = await harness.app.server.inject({
      method: 'PATCH',
      url: `/api/admin/life/cities/${ningboId}`,
      headers: ADMIN,
      payload: { active: false }
    });
    expect(res.statusCode).toBe(400);
    // 宁波仍是 active（未发生绕过 canonical 的停用）。
    const after = await harness.app.server.inject({ method: 'GET', url: '/api/admin/life/cities', headers: ADMIN });
    const active = (after.json() as { cities: Array<{ id: string; active: boolean }> }).cities.filter((c) => c.active);
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe(ningboId);
  });

  it('keeps the admin life endpoints behind the guard', async () => {
    harness = await createHarness({ skipStickerImport: true, startWorkers: false, env: { ADMIN_API_TOKEN: 'admin-test-token' } });
    const res = await harness.app.server.inject({ method: 'GET', url: '/api/admin/life/overview' });
    expect(res.statusCode).toBe(401);
  });
});
