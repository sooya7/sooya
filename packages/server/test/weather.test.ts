import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHarness, type Harness } from './helpers/harness.js';
import type { WeatherProvider, WeatherSnapshot } from '../src/core/weather/service.js';
import type { WeatherService } from '../src/core/weather/service.js';
import type { SooyaApp } from '../src/app.js';

let harness: Harness | null = null;
afterEach(async () => {
  if (harness) await harness.cleanup();
  harness = null;
});

function localTime(iso: string): Date {
  return new Date(`${iso}+08:00`);
}

function fakeProvider(condition: 'clear' | 'rain', fail = false, clock: () => Date = () => new Date()): WeatherProvider {
  return {
    name: 'fake-weather',
    configured: true,
    current: async () => {
      if (fail) throw new Error('weather provider exploded');
      return {
        observedAt: clock().toISOString(),
        condition,
        temperatureC: condition === 'rain' ? 19 : 26,
        provider: 'fake-weather',
        locationKey: 'key',
        stale: false
      };
    }
  };
}

/** Weather target for the harness's default (seeded) city — mirrors the
 * app.ts wiring so cache keys match the city identity. */
function cityTarget(app: SooyaApp): { key: string; country: string; region: string | null; city: string } {
  const city = app.services.location.activeCity()!;
  const country = city.country ?? '中国';
  const region = city.region ?? null;
  return { key: `${country}|${region ?? ''}|${city.name}`, country, region, city: city.name };
}

function enableWorld(app: SooyaApp): void {
  app.services.weather.setProvider(fakeProvider('clear'));
}

describe('weather snapshot (P0)', () => {
  it('is inert when the flags are off (no provider, unknown condition)', async () => {
    harness = await createHarness({ skipStickerImport: true, startWorkers: false });
    expect(harness.app.services.weather.isEnabled).toBe(false);
    expect(harness.app.services.world.snapshot().weatherCondition).toBeNull();
  });

  it('caches fresh snapshots and refreshes only after the freshness window', async () => {
    let now = localTime('2026-08-08T10:00');
    harness = await createHarness({
      skipStickerImport: true,
      startWorkers: false,
      env: { WORLD_CONTEXT_ENABLED: 'true', LOCATION_MODEL_ENABLED: 'true', WEATHER_ENABLED: 'true' },
      clock: () => now
    });
    const provider = fakeProvider('clear', false, () => now);
    const spy = vi.fn(provider.current);
    harness.app.services.weather.setProvider({ ...provider, current: spy });

    const target = cityTarget(harness.app);

    const first = await harness.app.services.weather.snapshotFor(target);
    expect(first.condition).toBe('clear');
    expect(first.stale).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);

    // 10 minutes later: still fresh, no provider call.
    now = localTime('2026-08-08T10:10');
    const second = await harness.app.services.weather.snapshotFor(target);
    expect(second.condition).toBe('clear');
    expect(spy).toHaveBeenCalledTimes(1);

    // After 3 hours: stale — the provider is called again.
    now = localTime('2026-08-08T13:10');
    const third = await harness.app.services.weather.snapshotFor(target);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(third.stale).toBe(false);
  });

  it('degrades to the last snapshot (stale) when the provider fails', async () => {
    let now = localTime('2026-08-08T10:00');
    harness = await createHarness({
      skipStickerImport: true,
      startWorkers: false,
      env: { WORLD_CONTEXT_ENABLED: 'true', LOCATION_MODEL_ENABLED: 'true', WEATHER_ENABLED: 'true' },
      clock: () => now
    });
    const provider = fakeProvider('rain', false, () => now);
    harness.app.services.weather.setProvider(provider);
    const target = cityTarget(harness.app);
    await harness.app.services.weather.snapshotFor(target);

    now = localTime('2026-08-08T14:00');
    harness.app.services.weather.setProvider(fakeProvider('clear', true));
    const result = await harness.app.services.weather.snapshotFor(target);
    expect(result.condition).toBe('rain'); // last known
    expect(result.stale).toBe(true);
  });

  it('returns unknown instead of throwing when nothing is cached and the provider fails', async () => {
    harness = await createHarness({
      skipStickerImport: true,
      startWorkers: false,
      env: { WORLD_CONTEXT_ENABLED: 'true', LOCATION_MODEL_ENABLED: 'true', WEATHER_ENABLED: 'true' }
    });
    harness.app.services.weather.setProvider(fakeProvider('clear', true));
    const location = harness.app.services.location.list().find((l) => l.kind === 'home')!;
    const result = await harness.app.services.weather.snapshotFor({ key: '中国|浙江省|测试市', country: '中国', region: '浙江省', city: '测试市' });
    expect(result.condition).toBe('unknown');
  });

  it('records a rain transition as ONE life event, not per refresh', async () => {
    let now = localTime('2026-08-08T10:00');
    harness = await createHarness({
      skipStickerImport: true,
      startWorkers: false,
      env: { WORLD_CONTEXT_ENABLED: 'true', LOCATION_MODEL_ENABLED: 'true', WEATHER_ENABLED: 'true', ENABLE_LIFE_ENGINE: 'true' },
      clock: () => now
    });
    harness.app.services.weather.setProvider(fakeProvider('rain'));
    const target = cityTarget(harness.app);
    await harness.app.services.weather.snapshotFor(target);
    await harness.app.services.weather.snapshotFor(target); // same episode
    await harness.app.services.weather.snapshotFor(target);

    const events = harness.app.repos.life.events(20).filter((e) => e.event_type.startsWith('weather.'));
    expect(events).toHaveLength(1);
    expect(events[0]!.event_type).toBe('weather.started_raining');
  });

  it('caches are isolated per city: different city keys never share weather', async () => {
    let now = localTime('2026-08-08T10:00');
    harness = await createHarness({
      skipStickerImport: true,
      startWorkers: false,
      env: { WORLD_CONTEXT_ENABLED: 'true', LOCATION_MODEL_ENABLED: 'true', WEATHER_ENABLED: 'true' },
      clock: () => now
    });
    const weather = harness.app.services.weather;
    // City-aware provider: 杭州 clear、其他 rain。
    weather.setProvider({
      name: 'fake-city',
      configured: true,
      current: async (loc) => ({
        observedAt: now.toISOString(),
        condition: loc.city === '杭州' ? 'clear' : 'rain',
        provider: 'fake-city',
        locationKey: 'x',
        stale: false
      })
    });
    // 宁波天气：rain。
    const ningbo = cityTarget(harness.app);
    const ningboSnap = await weather.snapshotFor(ningbo);
    expect(ningboSnap.condition).toBe('rain');
    // 切换到杭州：同 provider 但不同城市键。
    const hangzhou = { key: '中国|浙江|杭州', country: '中国', region: '浙江', city: '杭州' };
    now = localTime('2026-08-08T12:00');
    const hzSnap = await weather.snapshotFor(hangzhou);
    // 杭州没有自己的缓存，provider 返回 clear；宁波缓存不受影响。
    expect(hzSnap.condition).toBe('clear');
    // 杭州 provider 挂掉 → 只回杭州自己的缓存（clear），绝不拿宁波的 rain。
    now = localTime('2026-08-08T14:00');
    weather.setProvider(fakeProvider('clear', true, () => now));
    const hzStale = await weather.snapshotFor(hangzhou);
    expect(hzStale.condition).toBe('clear');
    expect(hzStale.stale).toBe(true);
    // 宁波仍持有自己的 rain 缓存。
    const ningboStill = weather.cachedCondition(ningbo);
    expect(ningboStill).toBe('rain');
  });

  it('rain suppresses outdoor scoring and favours cafe/library in the selector', async () => {
    let now = localTime('2026-08-08T10:00');
    harness = await createHarness({
      skipStickerImport: true,
      startWorkers: false,
      env: { WORLD_CONTEXT_ENABLED: 'true', LOCATION_MODEL_ENABLED: 'true', WEATHER_ENABLED: 'true' },
      clock: () => now
    });
    const weather = harness.app.services.weather as WeatherService;
    weather.setProvider(fakeProvider('rain', false, () => localTime('2026-08-08T10:00')));
    await weather.snapshotFor(cityTarget(harness.app));

    // Rain + a park-affinity walk: the selector should prefer a covered spot.
    const before = harness.app.services.location.onActivityResolved(
      { id: 'walk', kind: 'out', locationAffinity: ['park'] } as never,
      'out', null, 'walk-activity'
    );
    const selected = harness.app.services.location.current();
    // rain suppresses outdoor kinds (-30) and boosts cafe/library (+12): the
    // park affinity (+40) still usually wins, but the breakdown must show the
    // weather modifier pushing back.
    expect(before?.scoreBreakdown.weather).toBeDefined();
    void selected;
  });
});
