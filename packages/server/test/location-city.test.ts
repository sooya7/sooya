import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './helpers/harness.js';
import { LifeCityRepo } from '../src/db/repos/location.repo.js';

let harness: Harness | null = null;
afterEach(async () => {
  if (harness) await harness.cleanup();
  harness = null;
});

function localTime(iso: string): Date {
  return new Date(`${iso}+08:00`);
}

function enabledHarness() {
  return createHarness({
    skipStickerImport: true,
    startWorkers: false,
    env: { WORLD_CONTEXT_ENABLED: 'true', LOCATION_MODEL_ENABLED: 'true' },
    clock: () => localTime('2026-08-08T10:00')
  });
}

/**
 * LifeCity 多城市：默认城市种子、唯一 active 城市不变量、城市 CRUD、
 * 跨城旅行 → 城市切换 → 时区切换，以及重启后的城市持久化。
 */
describe('location cities (LifeCity)', () => {
  it('seeds a default active city and assigns builtin locations to it', async () => {
    harness = await enabledHarness();
    const service = harness.app.services.location;
    const cities = service.listCities();
    expect(cities.length).toBe(1);
    const city = service.activeCity()!;
    expect(city.name).toBe('默认城市');
    expect(city.timeZone).toBe('Asia/Shanghai');
    expect(city.active).toBe(true);
    // 内置地点都挂在默认城市下。
    for (const loc of service.list()) {
      expect(loc.cityId).toBe(city.id);
    }
  });

  it('keeps exactly one active city across create/update/deactivate', async () => {
    harness = await enabledHarness();
    const service = harness.app.services.location;
    const activeCount = () => service.listCities().filter((c) => c.active).length;

    // 新建城市默认不激活（第一个城市除外）。
    const bj = service.createCity({ name: '北京', country: '中国', timeZone: 'Asia/Shanghai' });
    expect(bj.active).toBe(false);
    expect(activeCount()).toBe(1);

    // 显式激活 → 其余自动停用。
    service.updateCity(bj.id, { active: true });
    expect(activeCount()).toBe(1);
    expect(service.activeCity()?.id).toBe(bj.id);

    // 停用 active 城市 → 自动补位另一个。
    expect(service.deactivateCity(bj.id)).toBe(true);
    expect(activeCount()).toBe(1);
    expect(service.activeCity()?.name).toBe('默认城市');
  });

  it('refuses to deactivate the last remaining city (invariant guard)', async () => {
    // 未启用 location 模型 → 无默认城市种子；单城市库才能触达"唯一城市"兜底。
    harness = await createHarness({ skipStickerImport: true, startWorkers: false });
    const service = harness.app.services.location;
    const city = service.createCity({ name: '孤城', timeZone: 'Asia/Shanghai' });
    expect(city.active).toBe(true); // 第一个城市自动激活
    const repo = new LifeCityRepo(harness.app.repos.locations.dbHandle);
    expect(repo.deactivate(city.id)).toBe(false);
    expect(repo.activeCity()?.id).toBe(city.id);
  });

  it('switches active city and timezone after a cross-city travel arrival', async () => {
    let at = localTime('2026-08-08T10:00');
    harness = await createHarness({
      skipStickerImport: true,
      startWorkers: false,
      env: { WORLD_CONTEXT_ENABLED: 'true', LOCATION_MODEL_ENABLED: 'true' },
      clock: () => at
    });
    const service = harness.app.services.location;
    const homeCity = service.activeCity()!;
    const tokyo = service.createCity({ name: '东京', country: '日本', timeZone: 'Asia/Tokyo' });
    expect(tokyo.active).toBe(false); // 新建城市默认不激活
    const tokyoCafe = harness.app.repos.locations.create({
      name: '东京咖啡店',
      kind: 'cafe',
      cityId: tokyo.id,
      tags: ['cafe', 'tokyo']
    });
    const builtinCafe = service.list().find((l) => l.kind === 'cafe' && l.cityId === homeCity.id)!;

    // 刚去过本城咖啡店（anti-repeat），东京咖啡店成为唯一选择。
    harness.app.repos.locations.recordVisit({ locationId: builtinCafe.id, enteredAt: at.toISOString() });
    const result = service.onActivityResolved(
      { id: 'cafe', kind: 'out', locationAffinity: ['cafe'] } as never,
      'out',
      null,
      null
    );
    expect(result?.locationId).toBe(tokyoCafe.id);
    // 途中：城市还没切（到达才切）。
    expect(service.activeCity()?.id).toBe(homeCity.id);
    expect(service.current()?.id).not.toBe(tokyoCafe.id);

    // 到达 → 城市切换 + 时区切换。
    at = localTime('2026-08-08T10:20');
    expect(service.current()?.id).toBe(tokyoCafe.id);
    expect(service.activeCity()?.id).toBe(tokyo.id);
    expect(service.timeZoneFor(service.current())).toBe('Asia/Tokyo');
    // 时区影响本地小时：10:20(+08) 在东京是 11:20。
    const { localHourAt } = await import('../src/core/location/tz.js');
    expect(localHourAt(at, service.timeZoneFor(service.current()))).toBe(11);
  });

  it('resolves timezone by priority: location.timeZone > city.timeZone > default', async () => {
    harness = await enabledHarness();
    const service = harness.app.services.location;
    const tokyo = service.createCity({ name: '东京', country: '日本', timeZone: 'Asia/Tokyo' });
    const ny = harness.app.repos.locations.create({
      name: '纽约分店',
      kind: 'cafe',
      cityId: tokyo.id,
      timeZone: 'America/New_York'
    });
    // 地点自带时区 > 城市时区。
    expect(service.timeZoneFor(service.get(ny.id)!)).toBe('America/New_York');
    // 城市时区 > 默认。
    const tokyoLoc = harness.app.repos.locations.create({ name: '东京公园', kind: 'park', cityId: tokyo.id });
    expect(service.timeZoneFor(service.get(tokyoLoc.id)!)).toBe('Asia/Tokyo');
    // 无城市 → 默认。
    const solo = harness.app.repos.locations.create({ name: '孤岛', kind: 'other' });
    expect(service.timeZoneFor(service.get(solo.id)!)).toBe('Asia/Shanghai');
  });

  it('cities and city_id persist across restart', async () => {
    let at = localTime('2026-08-08T10:00');
    harness = await createHarness({
      skipStickerImport: true,
      startWorkers: false,
      env: { WORLD_CONTEXT_ENABLED: 'true', LOCATION_MODEL_ENABLED: 'true' },
      clock: () => at
    });
    const dataDir = harness.app.env.dataDir;
    const service = harness.app.services.location;
    const tokyo = service.createCity({ name: '东京', country: '日本', timeZone: 'Asia/Tokyo' });
    service.setActiveCity(tokyo.id);
    const tokyoCafe = harness.app.repos.locations.create({ name: '东京咖啡店', kind: 'cafe', cityId: tokyo.id });
    service.override(tokyoCafe.id, '搬家去东京');
    await harness.app.close();
    harness = null;

    const second = await createHarness({
      skipStickerImport: true,
      startWorkers: false,
      env: { WORLD_CONTEXT_ENABLED: 'true', LOCATION_MODEL_ENABLED: 'true', DATA_DIR: dataDir },
      clock: () => localTime('2026-08-08T11:00')
    });
    harness = second;
    const svc = second.app.services.location;
    expect(svc.activeCity()?.name).toBe('东京');
    expect(svc.current()?.name).toBe('东京咖啡店');
    expect(svc.current()?.cityId).toBe(tokyo.id);
    expect(svc.listCities().length).toBe(2);
  });
});
