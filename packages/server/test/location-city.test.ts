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
    expect(city.name).toBe('宁波');
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
    expect(service.activeCity()?.name).toBe('宁波');
  });

  it('refuses to deactivate the last remaining city (invariant guard)', async () => {
    // 未启用 location 模型 → 无默认城市种子；单城市库才能触达"唯一城市"兜底。
    harness = await createHarness({ skipStickerImport: true, startWorkers: false, env: { WORLD_CONTEXT_ENABLED: 'false', LOCATION_MODEL_ENABLED: 'false' } });
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
    const hangzhou = service.createCity({ name: '杭州', region: '浙江', country: '中国' });
    expect(hangzhou.active).toBe(false); // 新建城市默认不激活（服务端固定中国/Asia/Shanghai）
    const hangzhouCafe = harness.app.repos.locations.create({
      name: '杭州咖啡店',
      kind: 'cafe',
      cityId: hangzhou.id,
      tags: ['cafe', 'hangzhou']
    });
    const builtinCafe = service.list().find((l) => l.kind === 'cafe' && l.cityId === homeCity.id)!;

    // 刚去过本城咖啡店（anti-repeat），杭州咖啡店成为唯一选择。
    harness.app.repos.locations.recordVisit({ locationId: builtinCafe.id, enteredAt: at.toISOString() });
    const result = service.onActivityResolved(
      { id: 'cafe', kind: 'out', locationAffinity: ['cafe'] } as never,
      'out',
      null,
      null
    );
    expect(result?.locationId).toBe(hangzhouCafe.id);
    // 途中：城市还没切（到达才切）。
    expect(service.activeCity()?.id).toBe(homeCity.id);
    expect(service.current()?.id).not.toBe(hangzhouCafe.id);

    // 到达 → 城市切换；时区恒为注入的 Asia/Shanghai（单时区运行语义）。
    at = localTime('2026-08-08T10:20');
    expect(service.current()?.id).toBe(hangzhouCafe.id);
    expect(service.activeCity()?.id).toBe(hangzhou.id);
    expect(service.timeZoneFor(service.current())).toBe('Asia/Shanghai');
    const { localHourAt } = await import('../src/core/location/tz.js');
    expect(localHourAt(at, service.timeZoneFor(service.current()))).toBe(10);
  });

  it('runtime timezone is always the injected Asia/Shanghai (single-timezone semantics)', async () => {
    harness = await enabledHarness();
    const service = harness.app.services.location;
    const hangzhou = service.createCity({ name: '杭州', region: '浙江', country: '中国' });
    // 历史 DB 时区字段可兼容保留，但不参与运行语义。
    const legacyTz = harness.app.repos.locations.create({
      name: '老分店',
      kind: 'cafe',
      cityId: hangzhou.id,
      timeZone: 'America/New_York'
    });
    expect(service.timeZoneFor(service.get(legacyTz.id)!)).toBe('Asia/Shanghai');
    const hzLoc = harness.app.repos.locations.create({ name: '杭州公园', kind: 'park', cityId: hangzhou.id });
    expect(service.timeZoneFor(service.get(hzLoc.id)!)).toBe('Asia/Shanghai');
    const solo = harness.app.repos.locations.create({ name: '无主地点', kind: 'other' });
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

  it('切换城市：取消在途行程、迁移日常地点归属、current 保持有效、Weather 跟随', async () => {
    let at = localTime('2026-08-08T10:00');
    harness = await createHarness({
      skipStickerImport: true,
      startWorkers: false,
      env: { WORLD_CONTEXT_ENABLED: 'true', LOCATION_MODEL_ENABLED: 'true', WEATHER_ENABLED: 'true' },
      clock: () => at
    });
    const service = harness.app.services.location;
    const ningbo = service.activeCity()!;
    expect(ningbo.name).toBe('宁波');
    expect(ningbo.country).toBe('中国');
    expect(ningbo.region).toBe('浙江');

    // 在途行程（防瞬移）+ 管理端切换城市。
    const cafe = service.list().find((l) => l.kind === 'cafe')!;
    service.onActivityResolved({ id: 'cafe', kind: 'out', locationAffinity: ['cafe'] } as never, 'out', null, null);
    expect(service.currentTravel()).toBeTruthy();

    const hangzhou = service.createCity({ name: '杭州', region: '浙江', country: '中国', timeZone: 'Asia/Shanghai' });
    service.setActiveCity(hangzhou.id);

    // 在途行程被取消（不残留跨城移动）；地点归属迁移、key/id 稳定。
    expect(service.currentTravel()).toBeNull();
    const homeAfter = service.list().find((l) => l.key === 'home')!;
    expect(homeAfter.cityId).toBe(hangzhou.id);
    expect(homeAfter.id).toBe(service.list().find((l) => l.key === 'home')!.id);
    // current 仍然有效（地点未删除）。
    expect(service.current()).toBeTruthy();
    // Weather 目标跟随新城市（WorldContext 的 weatherLocation 用 active city）。
    const target = harness.app.services.world.weatherLocation();
    expect(target?.city).toBe('杭州');
  });
});
