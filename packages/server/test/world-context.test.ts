import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './helpers/harness.js';
import { WorldContextService } from '../src/core/world-context.js';
import type { WeatherProviderFull } from '../src/core/weather/service.js';
import type { WeatherSnapshot } from '../src/db/repos/weather.repo.js';

let harness: Harness | null = null;
afterEach(async () => {
  if (harness) await harness.cleanup();
  harness = null;
});

function localTime(iso: string): Date {
  return new Date(`${iso}+08:00`);
}

const FLAGS = { WORLD_CONTEXT_ENABLED: 'true', LOCATION_MODEL_ENABLED: 'true', WEATHER_ENABLED: 'true' };

function fullProvider(clock: () => Date): WeatherProviderFull {
  return {
    name: 'fake-world',
    configured: true,
    current: async () => ({
      observedAt: clock().toISOString(),
      condition: 'clear',
      temperatureC: 26,
      feelsLikeC: 27,
      humidity: 60,
      windKph: 8,
      provider: 'fake-world',
      locationKey: 'key',
      stale: false
    }),
    forecast: async () => ({
      locationKey: 'key',
      generatedAt: clock().toISOString(),
      provider: 'fake-world',
      periods: [
        { at: new Date(clock().getTime() + 2 * 3_600_000).toISOString(), condition: 'storm', periodKind: 'hourly' },
        { at: new Date(clock().getTime() + 24 * 3_600_000).toISOString(), condition: 'clear', periodKind: 'daily' }
      ]
    }),
    daylight: async () => ({
      sunrise: new Date(clock().getTime() - 5 * 3_600_000).toISOString(),
      sunset: new Date(clock().getTime() + 8 * 3_600_000).toISOString(),
      isDaylight: true
    })
  };
}

describe('WorldContextService snapshot（contract §1.3）', () => {
  it('flags 全关时快照为缺省空态（不编造任何数据）', async () => {
    harness = await createHarness({ skipStickerImport: true, startWorkers: false });
    const snapshot = harness.app.services.world.snapshot();
    expect(snapshot.weatherCondition).toBeNull();
    expect(snapshot.location).toBeNull();
    expect(snapshot.previousLocation).toBeNull();
    expect(snapshot.weather).toBeNull();
    expect(snapshot.forecast).toBeNull();
    expect(snapshot.daylight).toBeNull();
    expect(snapshot.city).toBeNull();
    expect(snapshot.travel).toBeNull();
    expect(snapshot.timeZone).toBe('Asia/Shanghai');
    expect(typeof snapshot.now).toBe('string');
    expect(typeof snapshot.localDate).toBe('string');
  });

  it('refreshAll 后快照含完整字段：localDate/天气/forecast/daylight/location', async () => {
    let now = localTime('2026-08-08T10:00');
    harness = await createHarness({
      skipStickerImport: true,
      startWorkers: false,
      env: FLAGS,
      clock: () => now
    });
    harness.app.services.weather.setProvider(fullProvider(() => now));
    const home = harness.app.services.location.list().find((l) => l.kind === 'home')!;
    harness.app.services.location.override(home.id, 'test: 建立当前位置');

    const snapshot = await harness.app.services.world.refreshAll();
    expect(snapshot.location?.id).toBe(home.id);
    expect(snapshot.localDate).toBe('2026-08-08');
    expect(snapshot.timeZone).toBe('Asia/Shanghai');
    expect(snapshot.weather?.condition).toBe('clear');
    expect(snapshot.weather?.temperatureC).toBe(26);
    expect(snapshot.weather?.stale).toBe(false);
    expect(snapshot.forecast?.severe).toBe(true);          // 2 小时后 storm
    expect(snapshot.forecast?.next12h).toHaveLength(1);
    expect(snapshot.daylight?.isDaylight).toBe(true);
    expect(snapshot.weatherCondition).toBe('clear');
    // Agent A v25 集成后：默认城市真实播种，travel 在 override（瞬移）后为 null。
    expect(snapshot.city?.name).toBe('默认城市');
    expect(snapshot.travel).toBeNull();
  });

  it('同步 snapshot 只读缓存：不触发 provider 调用', async () => {
    let now = localTime('2026-08-08T10:00');
    harness = await createHarness({
      skipStickerImport: true,
      startWorkers: false,
      env: FLAGS,
      clock: () => now
    });
    const provider = fullProvider(() => now);
    let calls = 0;
    harness.app.services.weather.setProvider({ ...provider, current: async (loc) => { calls++; return provider.current(loc); } });
    const home = harness.app.services.location.list().find((l) => l.kind === 'home')!;
    harness.app.services.location.override(home.id, 'test: 建立当前位置');
    // 先填充缓存（异步）。
    await harness.app.services.world.refreshAll();
    expect(calls).toBe(1);
    // 同步快照不再调用 provider。
    const snapshot = harness.app.services.world.snapshot();
    expect(snapshot.weather?.condition).toBe('clear');
    expect(snapshot.forecast?.severe).toBe(true);
    expect(snapshot.daylight).not.toBeNull();
    expect(calls).toBe(1);
  });

  it('previousLocation 来自真实 visit 记录（首次无，第二次移动后为上一位置）', async () => {
    let now = localTime('2026-08-08T10:00');
    harness = await createHarness({
      skipStickerImport: true,
      startWorkers: false,
      env: FLAGS,
      clock: () => now
    });
    // 手动构造验证 previousLocation（app.ts 已注入 repos.locations，此处保持显式）。
    const world = new WorldContextService(
      harness.app.services.location,
      harness.app.services.weather,
      () => now,
      'Asia/Shanghai',
      harness.app.repos.locations
    );
    const locations = harness.app.services.location.list();
    const park = locations.find((l) => l.kind === 'park')!;
    const homeId = locations.find((l) => l.kind === 'home')!.id;
    const cafe = locations.find((l) => l.kind === 'cafe')!;

    // 第一次移动：Agent A 集成后 onActivityResolved 只"出发"（防瞬移），
    // 到达在 expectedArriveAt 到期后惰性结算——把时钟推进到行程到达。
    // 新库基线：启用即落在家里（home state + home visit）。
    harness.app.services.location.onActivityResolved({ id: 'walk', kind: 'out', locationAffinity: ['park'] } as never, 'out', null, 'walk-activity');
    now = new Date(now.getTime() + 30 * 60 * 1000);   // 步行 15min 兜底，推进 30min
    harness.app.services.location.current();
    expect(harness.app.services.location.current()?.id).toBe(park.id);
    expect(world.snapshot().previousLocation?.id).toBe(homeId);

    // 第二次移动：真实 visit 记录里上一个位置是 park。
    harness.app.services.location.onActivityResolved({ id: 'cafe', kind: 'out', locationAffinity: ['cafe'] } as never, 'out', null, null);
    now = new Date(now.getTime() + 30 * 60 * 1000);
    harness.app.services.location.current();
    expect(harness.app.services.location.current()?.id).toBe(cafe.id);
    const previous = world.snapshot().previousLocation;
    expect(previous?.id).toBe(park.id);
    expect(previous?.name).toBe(park.name);
  });

  it('provider 全挂时 refreshAll 不抛错，快照保持缺省', async () => {
    let now = localTime('2026-08-08T10:00');
    harness = await createHarness({
      skipStickerImport: true,
      startWorkers: false,
      env: FLAGS,
      clock: () => now
    });
    harness.app.services.weather.setProvider({ name: 'boom', configured: true, current: async () => { throw new Error('x'); } });
    const home = harness.app.services.location.list().find((l) => l.kind === 'home')!;
    harness.app.services.location.override(home.id, 'test: 建立当前位置');
    const snapshot = await harness.app.services.world.refreshAll();
    expect(snapshot.now).toBeTruthy();
    expect(snapshot.location).not.toBeNull();          // 位置是持久化的，不受天气影响
    expect(snapshot.weatherCondition).toBeNull();
  });

  it('缓存快照的 stale 标记：超过 120 分钟真实标记 stale', async () => {
    let now = localTime('2026-08-08T10:00');
    harness = await createHarness({
      skipStickerImport: true,
      startWorkers: false,
      env: FLAGS,
      clock: () => now
    });
    const provider = fullProvider(() => now);
    harness.app.services.weather.setProvider({ ...provider, current: async (loc) => ({ ...(await provider.current(loc)), observedAt: '2026-08-07T10:00:00.000Z' }) });
    const home = harness.app.services.location.list().find((l) => l.kind === 'home')!;
    harness.app.services.location.override(home.id, 'test: 建立当前位置');
    await harness.app.services.world.refreshAll();
    const snapshot = harness.app.services.world.snapshot();
    expect(snapshot.weather?.stale).toBe(true);        // 数据已超过 2 小时
  });
});

describe('WorldContextService weather 快照同步路径', () => {
  it('cachedCondition/cachedSnapshot 与语义字段一致（真实缓存，不编造）', async () => {
    let now = localTime('2026-08-08T10:00');
    harness = await createHarness({
      skipStickerImport: true,
      startWorkers: false,
      env: FLAGS,
      clock: () => now
    });
    const provider = fullProvider(() => now);
    harness.app.services.weather.setProvider(provider);
    const home = harness.app.services.location.list().find((l) => l.kind === 'home')!;
    harness.app.services.location.override(home.id, 'test: 建立当前位置');
    // Weather identity is the active city — cache the same city key the
    // WorldContext queries.
    const city = harness.app.services.location.activeCity()!;
    const country = city.country ?? '中国';
    const region = city.region ?? null;
    await harness.app.services.weather.snapshotFor({ key: `${country}|${region ?? ''}|${city.name}`, country, region, city: city.name });
    const world = harness.app.services.world;
    expect(world.snapshot().weatherCondition).toBe('clear');
    expect(world.snapshot().weather?.condition).toBe('clear');
    expect(world.snapshot().weather?.provider).toBe('fake-world');
  });
});

describe('快照字段类型回归（冻结契约形状）', () => {
  it('WorldSnapshot 字段集合与 contract §1.3 一致', async () => {
    harness = await createHarness({ skipStickerImport: true, startWorkers: false });
    const snapshot = harness.app.services.world.snapshot() as Record<string, unknown>;
    for (const field of ['now', 'localDate', 'timeZone', 'city', 'location', 'previousLocation', 'travel', 'weather', 'forecast', 'daylight', 'weatherCondition']) {
      expect(field in snapshot, `missing ${field}`).toBe(true);
    }
  });
});
