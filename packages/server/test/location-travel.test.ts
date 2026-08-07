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

/**
 * TravelState 防瞬移：活动解析只触发"出发"，expectedArriveAt 到期后惰性结算
 * （写 state + visit）；行程持久化，重启不漂移；管理端 override 取消行程。
 */
describe('location travel state (no teleport)', () => {
  it('starts a travel on activity resolution instead of teleporting', async () => {
    harness = await createHarness({
      skipStickerImport: true,
      startWorkers: false,
      env: { WORLD_CONTEXT_ENABLED: 'true', LOCATION_MODEL_ENABLED: 'true' },
      clock: () => localTime('2026-08-08T10:00')
    });
    const service = harness.app.services.location;
    const locations = service.list();
    const home = locations.find((l) => l.kind === 'home')!;
    const cafe = locations.find((l) => l.kind === 'cafe')!;

    service.onActivityResolved({ id: 'cafe', kind: 'out', locationAffinity: ['cafe'] } as never, 'out', null, null);

    // 没有瞬移：当前仍在出发地，行程在途。
    expect(service.current()?.id).toBe(home.id);
    const travel = service.currentTravel()!;
    expect(travel.fromLocationId).toBe(home.id);
    expect(travel.toLocationId).toBe(cafe.id);
    expect(travel.mode).toBe('walk');
    expect(travel.startedAt).toBe('2026-08-08T02:00:00.000Z');
    expect(travel.expectedArriveAt).toBe('2026-08-08T02:15:00.000Z');

    // Life 上下文能表达"正在走去咖啡店"。
    const lines = service.contextLines().join('\n');
    expect(lines).toContain('你现在在家');
    expect(lines).toContain('正在步行去街角咖啡店');
    expect(lines).toContain('预计15分钟后到');
  });

  it('writes state and visit only when the travel is due', async () => {
    let at = localTime('2026-08-08T10:00');
    harness = await createHarness({
      skipStickerImport: true,
      startWorkers: false,
      env: { WORLD_CONTEXT_ENABLED: 'true', LOCATION_MODEL_ENABLED: 'true' },
      clock: () => at
    });
    const service = harness.app.services.location;
    const home = service.list().find((l) => l.kind === 'home')!;
    const cafe = service.list().find((l) => l.kind === 'cafe')!;
    service.onActivityResolved({ id: 'cafe', kind: 'out', locationAffinity: ['cafe'] } as never, 'out', null, null);

    // 未到期：state 不更新。
    at = localTime('2026-08-08T10:14');
    expect(service.currentState()?.location_id).toBe(home.id);
    expect(service.current()?.id).toBe(home.id);

    // 到期瞬间：写 state + visit，行程清空。
    at = localTime('2026-08-08T10:15');
    expect(service.current()?.id).toBe(cafe.id);
    expect(service.currentTravel()).toBeNull();
    const visit = harness.app.repos.locations.recentVisits(5).find((v) => v.location_id === cafe.id)!;
    expect(visit.entered_at).toBe('2026-08-08T02:15:00.000Z');
    expect(visit.left_at).toBeNull();
  });

  it('does not re-travel when the activity already matches the current location', async () => {
    let at = localTime('2026-08-08T10:00');
    harness = await createHarness({
      skipStickerImport: true,
      startWorkers: false,
      env: { WORLD_CONTEXT_ENABLED: 'true', LOCATION_MODEL_ENABLED: 'true' },
      clock: () => at
    });
    const service = harness.app.services.location;
    const cafe = service.list().find((l) => l.kind === 'cafe')!;
    service.onActivityResolved({ id: 'cafe', kind: 'out', locationAffinity: ['cafe'] } as never, 'out', null, null);
    at = localTime('2026-08-08T10:16');
    expect(service.current()?.id).toBe(cafe.id);

    // 人已经在咖啡店，再来一个咖啡店活动：不产生新行程。
    at = localTime('2026-08-08T10:30');
    const result = service.onActivityResolved({ id: 'cafe', kind: 'out', locationAffinity: ['cafe'] } as never, 'out', null, null);
    expect(result?.locationId).toBe(cafe.id);
    expect(service.currentTravel()).toBeNull();
    expect(service.current()?.id).toBe(cafe.id);
  });

  it('admin override cancels an in-flight travel and teleports', async () => {
    harness = await createHarness({
      skipStickerImport: true,
      startWorkers: false,
      env: { WORLD_CONTEXT_ENABLED: 'true', LOCATION_MODEL_ENABLED: 'true' },
      clock: () => localTime('2026-08-08T10:00')
    });
    const service = harness.app.services.location;
    const park = service.list().find((l) => l.kind === 'park')!;
    service.onActivityResolved({ id: 'cafe', kind: 'out', locationAffinity: ['cafe'] } as never, 'out', null, null);
    expect(service.currentTravel()).not.toBeNull();

    const overridden = service.override(park.id, '突然想去公园');
    expect(overridden?.id).toBe(park.id);
    expect(service.currentTravel()).toBeNull();
    expect(service.current()?.id).toBe(park.id);
    // 到期的旧行程不会在之后"补到账"：override 已清空，settle 无行程可结算。
    expect(service.current()?.id).toBe(park.id);
  });

  it('persists an in-flight travel across restart and settles lazily on the new clock', async () => {
    harness = await createHarness({
      skipStickerImport: true,
      startWorkers: false,
      env: { WORLD_CONTEXT_ENABLED: 'true', LOCATION_MODEL_ENABLED: 'true' },
      clock: () => localTime('2026-08-08T10:00')
    });
    const dataDir = harness.app.env.dataDir;
    const cafe = harness.app.services.location.list().find((l) => l.kind === 'cafe')!;
    harness.app.services.location.onActivityResolved({ id: 'cafe', kind: 'out', locationAffinity: ['cafe'] } as never, 'out', null, null);
    // 重启时行程仍在途（10:00 出发，10:15 到）。
    expect(harness.app.services.location.currentTravel()).not.toBeNull();
    await harness.app.close();
    harness = null;

    // 重启后时钟已越过 expectedArriveAt：第一次读取即惰性结算。
    const second = await createHarness({
      skipStickerImport: true,
      startWorkers: false,
      env: { WORLD_CONTEXT_ENABLED: 'true', LOCATION_MODEL_ENABLED: 'true', DATA_DIR: dataDir },
      clock: () => localTime('2026-08-08T10:30')
    });
    harness = second;
    const svc = second.app.services.location;
    expect(svc.current()?.id).toBe(cafe.id);
    expect(svc.currentTravel()).toBeNull();
    const visit = second.app.repos.locations.recentVisits(5).find((v) => v.location_id === cafe.id)!;
    expect(visit.entered_at).toBe('2026-08-08T02:15:00.000Z');
  });

  it('falls back to a default 15-minute walk when no edge exists', async () => {
    harness = await createHarness({
      skipStickerImport: true,
      startWorkers: false,
      env: { WORLD_CONTEXT_ENABLED: 'true', LOCATION_MODEL_ENABLED: 'true' },
      clock: () => localTime('2026-08-08T10:00')
    });
    const service = harness.app.services.location;
    const faraway = harness.app.repos.locations.create({ name: '远郊小镇', kind: 'other', tags: ['faraway'] });
    // 用 thread 标签把选择器引向无边的地点。
    service.setThreadsProvider(() => [{ meta_json: JSON.stringify({ locationTags: ['faraway'] }), title: '去远郊逛逛' }]);
    service.onActivityResolved({ id: 'walk', kind: 'out', locationAffinity: ['other'] } as never, 'out', null, null);
    const travel = service.currentTravel()!;
    expect(travel.toLocationId).toBe(faraway.id);
    expect(travel.mode).toBe('walk');
    expect(Date.parse(travel.expectedArriveAt) - Date.parse(travel.startedAt)).toBe(15 * 60_000);
  });
});
