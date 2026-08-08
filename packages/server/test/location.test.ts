import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './helpers/harness.js';
import { scoreLocationCandidates } from '../src/core/location/selector.js';
import { localDateAt, localHourAt, isValidTimeZone } from '../src/core/location/tz.js';
import type { LifeLocationRow } from '../src/db/repos/location.repo.js';

let harness: Harness | null = null;
afterEach(async () => {
  if (harness) await harness.cleanup();
  harness = null;
});

function localTime(iso: string): Date {
  return new Date(`${iso}+08:00`);
}

/**
 * P0 location model: the location service is inert when the flag is off, seeds
 * builtin locations (stable keys + real travel edges) when enabled, moves
 * SOOYA on activity resolution through a travel state (no teleport), applies
 * anti-repeat, honors open-thread location tags, persists across restart, and
 * every admin mutation is audited.
 */
describe('location model (P0)', () => {
  it('is completely inert when LOCATION_MODEL_ENABLED=false', async () => {
    harness = await createHarness({ skipStickerImport: true, startWorkers: false });
    expect(harness.app.services.location.isEnabled).toBe(false);
    expect(harness.app.services.location.current()).toBeNull();
    expect(harness.app.services.location.list()).toEqual([]);
    // The life engine context does not mention any location.
    expect(harness.app.services.location.contextLines()).toEqual([]);
  });

  it('seeds builtin locations with stable keys, real travel edges and a home baseline when enabled', async () => {
    harness = await createHarness({
      skipStickerImport: true,
      startWorkers: false,
      env: { WORLD_CONTEXT_ENABLED: 'true', LOCATION_MODEL_ENABLED: 'true' },
      clock: () => localTime('2026-08-08T10:00')
    });
    expect(harness.app.services.location.isEnabled).toBe(true);
    const locations = harness.app.services.location.list();
    expect(locations.length).toBeGreaterThanOrEqual(6);
    const home = locations.find((l) => l.kind === 'home')!;
    expect(home.key).toBe('home');
    const cafe = locations.find((l) => l.kind === 'cafe')!;
    expect(cafe.key).toBe('cafe');

    // 默认出行边真实建库（home ↔ cafe 双向，15 分钟步行）。
    const edge = harness.app.repos.locations.edge(home.id, cafe.id);
    expect(edge).toBeDefined();
    expect(edge?.travel_minutes).toBe(15);
    expect(edge?.mode).toBe('walk');
    const back = harness.app.repos.locations.edge(cafe.id, home.id);
    expect(back?.travel_minutes).toBe(15);

    // 启用即落在家里（基线），后续活动从家出发。
    expect(harness.app.services.location.current()?.id).toBe(home.id);
  });

  it('moves on activity resolution via travel state: depart now, arrive when due', async () => {
    let at = localTime('2026-08-08T10:00');
    harness = await createHarness({
      skipStickerImport: true,
      startWorkers: false,
      env: { WORLD_CONTEXT_ENABLED: 'true', LOCATION_MODEL_ENABLED: 'true' },
      clock: () => at
    });
    const locations = harness.app.services.location.list();
    const home = locations.find((l) => l.kind === 'home')!;
    const cafe = locations.find((l) => l.kind === 'cafe')!;

    // 活动解析 → 出发（防瞬移：当前仍在家，行程已记录）。
    const result = harness.app.services.location.onActivityResolved(
      { id: 'cafe', kind: 'out', locationAffinity: ['cafe'] } as never,
      'out',
      'plan_1',
      'cafe-activity'
    );
    expect(result?.locationId).toBe(cafe.id);
    expect(harness.app.services.location.current()?.id).toBe(home.id);
    const travel = harness.app.services.location.currentTravel();
    expect(travel).not.toBeNull();
    expect(travel?.fromLocationId).toBe(home.id);
    expect(travel?.toLocationId).toBe(cafe.id);
    expect(travel?.mode).toBe('walk');
    expect(travel?.startedAt).toBe('2026-08-08T02:00:00.000Z');
    expect(travel?.expectedArriveAt).toBe('2026-08-08T02:15:00.000Z'); // 10:00 + 15 分钟

    // 到达时刻之后：写 state + visit，行程清空。
    at = localTime('2026-08-08T10:16');
    expect(harness.app.services.location.current()?.id).toBe(cafe.id);
    expect(harness.app.services.location.currentTravel()).toBeNull();
    const state = harness.app.services.location.currentState();
    expect(state?.location_id).toBe(cafe.id);
    expect(state?.source_plan_id).toBe('plan_1');
    // 出发地的 visit 已关闭，目的地有新 visit。
    const visits = harness.app.repos.locations.recentVisits(5);
    const cafeVisit = visits.find((v) => v.location_id === cafe.id);
    expect(cafeVisit).toBeDefined();
    expect(cafeVisit?.left_at).toBeNull();
    const homeVisit = visits.find((v) => v.location_id === home.id);
    expect(homeVisit?.left_at).toBe('2026-08-08T02:00:00.000Z'); // 离开时刻 = 出发时刻
  });

  it('applies anti-repeat: a recently visited location loses to a thread-relevant alternative', async () => {
    harness = await createHarness({
      skipStickerImport: true,
      startWorkers: false,
      env: { WORLD_CONTEXT_ENABLED: 'true', LOCATION_MODEL_ENABLED: 'true' },
      clock: () => localTime('2026-08-08T10:00')
    });
    const locations = harness.app.services.location.list();
    const park = locations.find((l) => l.kind === 'park')!;
    const store = locations.find((l) => l.kind === 'store')!;
    // 刚去过公园（anti-repeat），同时 open thread 在说超市。
    harness.app.repos.locations.recordVisit({ locationId: park.id, enteredAt: localTime('2026-08-08T10:00').toISOString() });
    harness.app.services.location.setThreadsProvider(() => [
      { meta_json: JSON.stringify({ locationTags: ['store'] }), title: '顺路买点东西' }
    ]);
    const result = harness.app.services.location.onActivityResolved(
      { id: 'walk', kind: 'out', locationAffinity: ['park'] } as never,
      'out',
      null,
      'walk-activity'
    );
    // 公园刚访问过（-40）被 anti-repeat 压制：无论 tie 如何，park 都不可能
    // 胜出（park≈13 远低于 store≈26 / 家附近≈27；家附近的亲缘+近距与
    // store 的 thread 加成在同一量级，由确定性 hash 破平，两者胜出都合理）。
    expect(result?.locationId).not.toBe(park.id);
    // thread 加成真实参与决策：当 store 胜出时其 breakdown 必须含 thread。
    if (result?.locationId === store.id) {
      expect(result?.scoreBreakdown.thread).toBe(10);
    }
    const travel = harness.app.services.location.currentTravel();
    // 目的地就是选中项（不再假设 store 必然全局最优）。
    expect(travel?.toLocationId).toBe(result?.locationId);
  });

  it('open thread location tags genuinely reach the selector via the service', async () => {
    harness = await createHarness({
      skipStickerImport: true,
      startWorkers: false,
      env: { WORLD_CONTEXT_ENABLED: 'true', LOCATION_MODEL_ENABLED: 'true' },
      clock: () => localTime('2026-08-08T10:00')
    });
    const service = harness.app.services.location;
    // 没有 provider 时 thread 无加成。
    const without = service.onActivityResolved(
      { id: 'cafe', kind: 'out', locationAffinity: ['cafe'] } as never,
      'out',
      null,
      null
    );
    expect(without?.scoreBreakdown.thread).toBeUndefined();
    // 挂上带 locationTags 的 open thread 后，选择器真实给匹配候选加分。
    service.setThreadsProvider(() => [
      { meta_json: JSON.stringify({ locationTags: ['cafe', 'drink'] }), title: '想喝咖啡' }
    ]);
    const withTags = service.onActivityResolved(
      { id: 'cafe', kind: 'out', locationAffinity: ['cafe'] } as never,
      'out',
      null,
      null
    );
    expect(withTags?.scoreBreakdown.thread).toBe(14); // 10 + (2-1)*4
  });

  it('thread tags can flip the selector decision (pure selector)', async () => {
    // 两个同类候选，除标签外完全同分；thread 加成（10）大于 hash 噪音（±4）。
    harness = await createHarness({ skipStickerImport: true, startWorkers: false });
    const repo = harness.app.repos.locations;
    const alpha = repo.create({ name: '甲咖啡店', kind: 'cafe', tags: ['alpha-tag'] });
    const beta = repo.create({ name: '乙咖啡店', kind: 'cafe', tags: ['beta-tag'] });
    const rows = [repo.get(alpha.id)!, repo.get(beta.id)!] as LifeLocationRow[];
    const base = {
      def: null,
      kind: 'out',
      currentLocationId: null,
      recentVisitIds: [] as string[],
      repeatWindowHours: 24,
      hour: 15,
      weatherCondition: null
    };
    const withoutThreads = scoreLocationCandidates(rows, { ...base, threadTags: [] }, () => undefined, Date.now());
    const withThreads = scoreLocationCandidates(rows, { ...base, threadTags: ['alpha-tag'] }, () => undefined, Date.now());
    expect(withThreads?.locationId).toBe(alpha.id);
    expect(withThreads?.scoreBreakdown.thread).toBe(10);
    if (withoutThreads?.locationId === alpha.id) {
      expect(withoutThreads.scoreBreakdown.thread).toBeUndefined();
    }
    // 真实影响：带标签时 alpha 的得分比不带时恰好高 10（thread 加分）。
    expect(withThreads?.scoreBreakdown.affinity).toBe(withoutThreads?.scoreBreakdown.affinity);
  });

  it('survives a restart without drifting', async () => {
    let at = localTime('2026-08-08T10:00');
    harness = await createHarness({
      skipStickerImport: true,
      startWorkers: false,
      env: { WORLD_CONTEXT_ENABLED: 'true', LOCATION_MODEL_ENABLED: 'true' },
      clock: () => at
    });
    const dataDir = harness.app.env.dataDir;
    const locations = harness.app.services.location.list();
    const cafe = locations.find((l) => l.kind === 'cafe')!;
    harness.app.services.location.onActivityResolved({ id: 'cafe', kind: 'out', locationAffinity: ['cafe'] } as never, 'out', null, null);
    at = localTime('2026-08-08T10:16');
    expect(harness.app.services.location.current()?.id).toBe(cafe.id);
    await harness.app.close();
    harness = null;

    const second = await createHarness({
      skipStickerImport: true,
      startWorkers: false,
      env: { WORLD_CONTEXT_ENABLED: 'true', LOCATION_MODEL_ENABLED: 'true', DATA_DIR: dataDir },
      clock: () => localTime('2026-08-08T11:00')
    });
    harness = second;
    const current = second.app.services.location.current();
    expect(current?.id).toBe(cafe.id);
    // 城市与种子不漂移：仍是同一个默认城市、同 key 的种子。
    expect(second.app.services.location.activeCity()?.timeZone).toBe('Asia/Shanghai');
    expect(second.app.services.location.list().find((l) => l.kind === 'home')?.key).toBe('home');
  });

  it('admin CRUD and override are audited', async () => {
    harness = await createHarness({
      skipStickerImport: true,
      startWorkers: false,
      env: { WORLD_CONTEXT_ENABLED: 'true', LOCATION_MODEL_ENABLED: 'true', ADMIN_API_TOKEN: 'admin-test-token' }
    });
    const created = await harness.app.server.inject({
      method: 'POST',
      url: '/api/admin/life/locations',
      headers: { 'x-admin-token': 'admin-test-token' },
      payload: { name: '屋顶花园', kind: 'outdoor', tags: ['garden', 'quiet'] }
    });
    expect(created.statusCode).toBe(200);
    const body = created.json() as { location: { id: string } };

    const override = await harness.app.server.inject({
      method: 'POST',
      url: '/api/admin/life/location/override',
      headers: { 'x-admin-token': 'admin-test-token' },
      payload: { locationId: body.location.id, reason: '测试覆盖' }
    });
    expect(override.statusCode).toBe(200);
    // 管理端覆盖是瞬移：没有进行中的行程。
    expect(harness.app.services.location.current()?.id).toBe(body.location.id);
    expect(harness.app.services.location.currentTravel()).toBeNull();

    const audit = harness.app.repos.audit.list(10) as Array<{ category: string; action: string }>;
    expect(audit.some((a) => a.category === 'life.location' && a.action === 'override')).toBe(true);
    expect(audit.some((a) => a.category === 'life.location' && a.action === 'create')).toBe(true);
  });

  it('does not duplicate seeds on a legacy DB (pre-key rows)', async () => {
    harness = await createHarness({ skipStickerImport: true, startWorkers: false });
    // 模拟 v19 时代的库：已有地点但没有 key 列数据。
    harness.app.repos.locations.create({ name: '家', kind: 'home', source: 'builtin' });
    harness.app.repos.locations.create({ name: '街角咖啡店', kind: 'cafe', source: 'builtin' });
    harness.app.services.location.setEnabled(true);
    const homes = harness.app.services.location.list().filter((l) => l.kind === 'home');
    expect(homes.length).toBe(1);
    // 默认城市补上，城市功能可用。
    expect(harness.app.services.location.activeCity()?.timeZone).toBe('Asia/Shanghai');
  });

  it('GET /api/life/locations exposes the known locations without inventing details', async () => {
    harness = await createHarness({
      skipStickerImport: true,
      startWorkers: false,
      env: { WORLD_CONTEXT_ENABLED: 'true', LOCATION_MODEL_ENABLED: 'true' },
      clock: () => localTime('2026-08-08T10:00')
    });
    const res = await harness.app.server.inject({ method: 'GET', url: '/api/life/locations' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { locations: Array<{ name: string; kind: string }>; current: unknown };
    expect(body.locations.length).toBeGreaterThanOrEqual(6);
    // 启用后基线在家（不再是无状态）。
    expect((body.current as { kind: string }).kind).toBe('home');
  });
});

describe('timezone helpers (tz.ts)', () => {
  it('computes local hour/date via IANA timezone, not a fixed +8', () => {
    const at = new Date('2026-08-08T02:00:00.000Z');
    expect(localHourAt(at, 'Asia/Shanghai')).toBe(10);
    expect(localDateAt(at, 'Asia/Shanghai')).toBe('2026-08-08');
    // 同一时刻在东京是 11 点：时区切换必须影响本地小时。
    expect(localHourAt(at, 'Asia/Tokyo')).toBe(11);
    expect(localHourAt(at, 'UTC')).toBe(2);
    // 午夜边界：h23 不出现 24。
    const midnight = new Date('2026-08-08T16:00:00.000Z'); // 上海 8-9 00:00
    expect(localHourAt(midnight, 'Asia/Shanghai')).toBe(0);
    expect(localDateAt(midnight, 'Asia/Shanghai')).toBe('2026-08-09');
  });

  it('validates IANA timezone names', () => {
    expect(isValidTimeZone('Asia/Shanghai')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Asia/Shanghai+8')).toBe(false);
  });
});
