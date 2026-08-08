import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHarness, sendText, type Harness } from './helpers/harness.js';
import { createWeatherProvider, OpenMeteoWeatherProvider, wmoCondition } from '../src/core/weather/provider.js';
import { FallbackWeatherProvider, type WeatherCacheReader } from '../src/core/weather/fallback.js';
import { summarizeForecast, severeWithinHours, type WeatherForecast } from '../src/core/weather/forecast.js';
import { severeWeatherKinds } from '../src/core/weather/severe.js';
import { astronomyDaylight, computeIsDaylight } from '../src/core/weather/daylight.js';
import { scoreActivity, defById } from '../src/core/life2/activities.js';
import type { WeatherProviderFull } from '../src/core/weather/service.js';
import type { WeatherSnapshot } from '../src/db/repos/weather.repo.js';
import type { LifeV2Repo } from '../src/db/repos/life-v2.repo.js';
import { zonedParts } from '../src/util/time-zone.js';

let harness: Harness | null = null;
afterEach(async () => {
  if (harness) await harness.cleanup();
  harness = null;
});

function localTime(iso: string): Date {
  return new Date(`${iso}+08:00`);
}

/** open-meteo 假响应 fetch。 */
function omFetch(json: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(json), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })) as typeof fetch;
}

const SHANGHAI = { key: 'shanghai', lat: 31.23, lng: 121.47 };

/** 测试用的 LifeV2Repo 桩：无历史使用记录。 */
function usageStub(): LifeV2Repo {
  return {
    getUsage: () => undefined,
    recentActivityUsage: () => []
  } as unknown as LifeV2Repo;
}

function scoreCtx(overrides: Record<string, unknown> = {}) {
  return {
    vitals: { hunger: 30, energy: 70, stress: 20, comfort: 50, focus: 50, curiosity: 50, social_need: 40, loneliness: 30, sleep_debt: 0 },
    hour: 15,
    dayIndex: 100,
    slotIndex: 15,
    usage: usageStub(),
    themeTags: [],
    threadFitIds: new Set<string>(),
    continuityFrom: [],
    ...overrides
  } as never;
}

function fullSnapshot(condition: WeatherSnapshot['condition'], overrides: Partial<WeatherSnapshot> = {}): WeatherSnapshot {
  return { observedAt: '2026-08-08T02:00:00.000Z', condition, temperatureC: 26, provider: 'fake', locationKey: 'k', stale: false, ...overrides };
}

describe('provider factory + open-meteo adapter', () => {
  it('工厂未配置时返回 configured=false 的 no-op', () => {
    const provider = createWeatherProvider({});
    expect(provider.configured).toBe(false);
    expect(provider.name).toBe('none');
    expect(createWeatherProvider({ provider: 'does-not-exist' }).configured).toBe(false);
  });

  it('工厂按名称创建 open-meteo 适配器', () => {
    const provider = createWeatherProvider({ provider: 'open-meteo' });
    expect(provider.configured).toBe(true);
    expect(provider.name).toBe('open-meteo');
  });

  it('wmoCondition 映射六类严重天气与常见 code', () => {
    expect(wmoCondition(0)).toBe('clear');
    expect(wmoCondition(3)).toBe('cloudy');
    expect(wmoCondition(48)).toBe('fog');
    expect(wmoCondition(61)).toBe('rain');
    expect(wmoCondition(71)).toBe('snow');
    expect(wmoCondition(95)).toBe('storm');
    expect(wmoCondition(999)).toBe('unknown');
    expect(wmoCondition(null)).toBe('unknown');
  });

  it('open-meteo current 返回完整字段（含 visibility/pressure，本地时间换算）', async () => {
    const provider = new OpenMeteoWeatherProvider({
      fetchImpl: omFetch({
        timezone: 'Asia/Shanghai',
        utc_offset_seconds: 28800,
        current: {
          time: '2026-08-08T10:00',
          temperature_2m: 31.2,
          relative_humidity_2m: 82,
          apparent_temperature: 34.5,
          precipitation: 2.4,
          weather_code: 95,
          wind_speed_10m: 18.3,
          visibility: 8500,
          pressure_msl: 1004.2
        }
      }),
      clock: () => localTime('2026-08-08T10:00')
    });
    const snapshot = await provider.current(SHANGHAI);
    expect(snapshot.condition).toBe('storm');
    expect(snapshot.temperatureC).toBe(31.2);
    expect(snapshot.feelsLikeC).toBe(34.5);
    expect(snapshot.humidity).toBe(82);
    expect(snapshot.precipitationMm).toBe(2.4);
    expect(snapshot.windKph).toBe(18.3);
    expect(snapshot.visibilityKm).toBe(9);   // 8500m → 9km
    expect(snapshot.pressureHpa).toBe(1004.2);
    expect(snapshot.observedAt).toBe('2026-08-08T02:00:00.000Z'); // 本地 10:00 = UTC 02:00
    expect(snapshot.provider).toBe('open-meteo');
    expect(snapshot.stale).toBe(false);
  });

  it('open-meteo 缺坐标时抛错（链会继续降级，不炸出服务层）', async () => {
    const provider = new OpenMeteoWeatherProvider({ fetchImpl: omFetch({ current: {} }) });
    await expect(provider.current({ key: 'no-coords' })).rejects.toThrow(/坐标/);
  });

  it('open-meteo forecast 返回 12 逐小时 + 3 每日，severe 判定正确', async () => {
    const hourlyTimes = Array.from({ length: 12 }, (_, i) => `2026-08-08T${String(10 + i).padStart(2, '0')}:00`);
    const codes = hourlyTimes.map((_, i) => (i === 2 ? 80 : i === 3 ? 95 : 0)); // 12:00 阵雨 13:00 雷暴
    const precipitation = hourlyTimes.map((_, i) => (i === 2 ? 12 : 0));
    const provider = new OpenMeteoWeatherProvider({
      fetchImpl: omFetch({
        timezone: 'Asia/Shanghai',
        utc_offset_seconds: 28800,
        hourly: {
          time: hourlyTimes,
          temperature_2m: hourlyTimes.map(() => 30),
          precipitation,
          weather_code: codes,
          wind_speed_10m: hourlyTimes.map(() => 15)
        },
        daily: {
          time: ['2026-08-08', '2026-08-09', '2026-08-10'],
          weather_code: [0, 1, 61],
          temperature_2m_max: [31, 32, 28],
          temperature_2m_min: [24, 25, 23],
          precipitation_sum: [4, 0, 6]
        }
      }),
      clock: () => localTime('2026-08-08T10:00')
    });
    const forecast = await provider.forecast(SHANGHAI);
    expect(forecast).not.toBeNull();
    expect(forecast!.periods).toHaveLength(15);
    expect(forecast!.periods.filter((p) => p.periodKind === 'hourly')).toHaveLength(12);
    expect(forecast!.periods.filter((p) => p.periodKind === 'daily')).toHaveLength(3);

    const summary = summarizeForecast(forecast!.periods, forecast!.generatedAt, forecast!.provider, localTime('2026-08-08T10:00'));
    expect(summary.next12h).toHaveLength(12);
    expect(summary.next3d).toHaveLength(3);
    expect(summary.severe).toBe(true);
    // 13:00 本地（2 小时内）雷暴 → severeWithinHours 命中
    expect(severeWithinHours(summary, localTime('2026-08-08T10:00').toISOString(), 2)).toBe(true);
    // 只看未来 1 小时（11:00 前无 severe）→ 不命中
    expect(severeWithinHours(summary, localTime('2026-08-08T10:00').toISOString(), 1)).toBe(false);
  });

  it('open-meteo daylight 返回本地日出日落并即时计算 isDaylight', async () => {
    const provider = new OpenMeteoWeatherProvider({
      fetchImpl: omFetch({
        timezone: 'Asia/Shanghai',
        utc_offset_seconds: 28800,
        daily: {
          time: ['2026-08-08'],
          sunrise: ['2026-08-08T05:12'],
          sunset: ['2026-08-08T18:45']
        }
      }),
      clock: () => localTime('2026-08-08T10:00')
    });
    const daylight = await provider.daylight(SHANGHAI);
    expect(daylight).not.toBeNull();
    expect(daylight!.sunrise).toBe('2026-08-07T21:12:00.000Z');
    expect(daylight!.sunset).toBe('2026-08-08T10:45:00.000Z');
    expect(daylight!.isDaylight).toBe(true);
  });

  it('severeWeatherKinds 阈值正确（暴雨/酷热/严寒/大风）', () => {
    expect(severeWeatherKinds('storm')).toEqual(['storm']);
    expect(severeWeatherKinds('rain', 20, 10, 12)).toEqual(['heavy_rain']);
    expect(severeWeatherKinds('rain', 20, 10, 9)).toEqual([]);
    expect(severeWeatherKinds('clear', 36)).toEqual(['extreme_heat']);
    expect(severeWeatherKinds('clear', -12)).toEqual(['extreme_cold']);
    expect(severeWeatherKinds('clear', 20, 70)).toEqual(['strong_wind']);
    expect(severeWeatherKinds('snow', -2)).toEqual(['snow']);
  });
});

describe('FallbackWeatherProvider 降级链', () => {
  const cache: WeatherCacheReader = {
    latest: (key) => key === 'k'
      ? {
          location_key: 'k',
          observed_at: '2026-08-07T10:00:00.000Z',
          condition: 'rain',
          temperature_c: 19,
          feels_like_c: null,
          humidity: null,
          precipitation_mm: null,
          wind_kph: null,
          visibility_km: null,
          pressure_hpa: null,
          provider: 'open-meteo',
          created_at: '2026-08-07T10:00:00.000Z'
        }
      : undefined,
    latestForecast: () => undefined
  };

  it('primary 失败 → secondary 服务', async () => {
    const primary: WeatherProviderFull = { name: 'p', configured: true, current: async () => { throw new Error('primary exploded'); } };
    const secondary: WeatherProviderFull = { name: 's', configured: true, current: async () => fullSnapshot('clear', { provider: 's' }) };
    const chain = new FallbackWeatherProvider({ primary, secondary, cache });
    const snapshot = await chain.current({ key: 'k' });
    expect(snapshot.provider).toBe('s');
    expect(snapshot.stale).toBe(false);
    expect(snapshot.degraded).toBeUndefined();
  });

  it('primary/secondary 全失败 → 缓存快照（stale + degraded）', async () => {
    const fail: WeatherProviderFull = { name: 'p', configured: true, current: async () => { throw new Error('boom'); } };
    const chain = new FallbackWeatherProvider({ primary: fail, secondary: fail, cache });
    const snapshot = await chain.current({ key: 'k' });
    expect(snapshot.condition).toBe('rain');
    expect(snapshot.provider).toBe('cache');
    expect(snapshot.stale).toBe(true);
    expect(snapshot.degraded).toBe(true);
  });

  it('全失败且无缓存 → unknown（绝不抛出）', async () => {
    const fail: WeatherProviderFull = { name: 'p', configured: true, current: async () => { throw new Error('boom'); } };
    const chain = new FallbackWeatherProvider({ primary: fail, secondary: fail, cache: { latest: () => undefined, latestForecast: () => undefined } });
    const snapshot = await chain.current({ key: 'missing' });
    expect(snapshot.condition).toBe('unknown');
    expect(snapshot.provider).toBe('unknown');
    expect(snapshot.degraded).toBe(true);
  });

  it('configured 取决于主备任一真实配置', () => {
    const chain = new FallbackWeatherProvider({ primary: null, secondary: null });
    expect(chain.configured).toBe(false);
    const one = new FallbackWeatherProvider({ primary: { name: 'x', configured: true, current: async () => fullSnapshot('clear') }, secondary: null });
    expect(one.configured).toBe(true);
  });
});

describe('WeatherService forecast / daylight（harness）', () => {
  function fakeFullProvider(clock: () => Date): WeatherProviderFull {
    return {
      name: 'fake-full',
      configured: true,
      current: async () => fullSnapshot('clear', { observedAt: clock().toISOString() }),
      forecast: async () => ({
        locationKey: 'key',
        generatedAt: clock().toISOString(),
        provider: 'fake-full',
        periods: [
          ...Array.from({ length: 12 }, (_, i) => ({
            at: new Date(clock().getTime() + (i + 1) * 3_600_000).toISOString(),
            condition: i === 3 ? 'rain' as const : 'clear' as const,
            precipitationMm: i === 3 ? 14 : 0,
            periodKind: 'hourly' as const
          })),
          ...Array.from({ length: 3 }, (_, i) => ({
            at: new Date(clock().getTime() + (i + 1) * 24 * 3_600_000).toISOString(),
            condition: 'cloudy' as const,
            periodKind: 'daily' as const
          }))
        ]
      }),
      daylight: async () => ({
        sunrise: new Date(clock().getTime() - 5 * 3_600_000).toISOString(),
        sunset: new Date(clock().getTime() + 8 * 3_600_000).toISOString(),
        isDaylight: true
      })
    };
  }

  it('forecastFor 缓存 30 分钟；provider 故障后回退缓存摘要', async () => {
    let now = localTime('2026-08-08T10:00');
    harness = await createHarness({
      skipStickerImport: true,
      startWorkers: false,
      env: { WORLD_CONTEXT_ENABLED: 'true', LOCATION_MODEL_ENABLED: 'true', WEATHER_ENABLED: 'true' },
      clock: () => now
    });
    const weather = harness.app.services.weather;
    const provider = fakeFullProvider(() => now);
    const spyForecast = vi.fn(provider.forecast!);
    weather.setProvider({ ...provider, forecast: spyForecast });
    const location = harness.app.services.location.list().find((l) => l.kind === 'home')!;
    const target = { key: location.id };

    const first = await weather.forecastFor(target);
    expect(first).not.toBeNull();
    expect(first!.next12h).toHaveLength(12);
    expect(first!.next3d).toHaveLength(3);
    expect(first!.severe).toBe(true);
    expect(spyForecast).toHaveBeenCalledTimes(1);

    // 30 分钟内：读缓存，不再请求。
    now = localTime('2026-08-08T10:20');
    const second = await weather.forecastFor(target);
    expect(second!.severe).toBe(true);
    expect(spyForecast).toHaveBeenCalledTimes(1);

    // 超过 30 分钟且 provider 全挂：回退缓存摘要，不抛错。
    now = localTime('2026-08-08T10:31');
    weather.setProvider({ name: 'boom', configured: true, current: async () => { throw new Error('x'); } });
    const third = await weather.forecastFor(target);
    expect(third).not.toBeNull();
    expect(third!.provider).toBe('fake-full'); // 来自缓存行
  });

  it('daylightFor 按本地日期缓存；provider 缺失时回退缓存/天文估算', async () => {
    let now = localTime('2026-08-08T10:00');
    harness = await createHarness({
      skipStickerImport: true,
      startWorkers: false,
      env: { WORLD_CONTEXT_ENABLED: 'true', LOCATION_MODEL_ENABLED: 'true', WEATHER_ENABLED: 'true' },
      clock: () => now
    });
    const weather = harness.app.services.weather;
    weather.setProvider(fakeFullProvider(() => now));
    const location = harness.app.services.location.list().find((l) => l.kind === 'home')!;
    const target = { key: location.id };

    const first = await weather.daylightFor(target, now, 'Asia/Shanghai');
    expect(first).not.toBeNull();
    expect(first!.isDaylight).toBe(true);

    // provider 挂了：本地日期当天命中缓存。
    weather.setProvider({ name: 'boom', configured: true, current: async () => { throw new Error('x'); } });
    const second = await weather.daylightFor(target, now, 'Asia/Shanghai');
    expect(second).not.toBeNull();

    // 同步缓存路径同样命中。
    const sync = weather.cachedDaylight(target, now, 'Asia/Shanghai');
    expect(sync).not.toBeNull();

    // 无缓存 + 有坐标 → 天文估算（上海 2026-08-08 日出约 05:12，容差 ±20 分钟）。
    const astro = weather.cachedDaylight({ key: 'astro', lat: 31.23, lng: 121.47 }, now, 'Asia/Shanghai');
    expect(astro).not.toBeNull();
    const rise = zonedParts(new Date(astro!.sunrise), 'Asia/Shanghai');
    expect(rise.hour * 60 + rise.minute).toBeGreaterThanOrEqual(4 * 60 + 52);
    expect(rise.hour * 60 + rise.minute).toBeLessThanOrEqual(5 * 60 + 32);
  });
});

describe('activity scoring: forecast / daylight 修饰', () => {
  it('forecast 暴雨（2 小时内）→ 长时间户外减分', () => {
    const walk = defById('walk')!;
    const severeSummary = {
      generatedAt: '2026-08-08T02:00:00.000Z',
      provider: 'fake',
      next12h: [
        { at: '2026-08-08T03:00:00.000Z', condition: 'rain' as const, precipitationMm: 14, periodKind: 'hourly' as const }
      ],
      next3d: [],
      severe: true
    };
    const nowIso = '2026-08-08T02:30:00.000Z';
    const base = scoreActivity(walk, scoreCtx({ hour: 10, slotIndex: 10, dayIndex: 42 }), nowIso);
    const stormy = scoreActivity(walk, scoreCtx({ hour: 10, slotIndex: 10, dayIndex: 42, forecast: severeSummary }), nowIso);
    expect(stormy).toBeLessThan(base);
  });

  it('forecast 无 severe 时不影响户外评分', () => {
    const walk = defById('walk')!;
    const calm = {
      generatedAt: '2026-08-08T02:00:00.000Z',
      provider: 'fake',
      next12h: [{ at: '2026-08-08T03:00:00.000Z', condition: 'clear' as const, periodKind: 'hourly' as const }],
      next3d: [],
      severe: false
    };
    const nowIso = '2026-08-08T02:30:00.000Z';
    const base = scoreActivity(walk, scoreCtx({ hour: 10, slotIndex: 10, dayIndex: 42 }), nowIso);
    const calmScore = scoreActivity(walk, scoreCtx({ hour: 10, slotIndex: 10, dayIndex: 42, forecast: calm }), nowIso);
    expect(calmScore).toBe(base);
  });

  it('日落后（isDaylight=false）傍晚 walk 获得 daylight 加分', () => {
    const walk = defById('walk')!;
    const afterSunset = { sunrise: '2026-08-08T00:00:00.000Z', sunset: '2026-08-08T10:00:00.000Z', isDaylight: false };
    const beforeSunset = { sunrise: '2026-08-08T00:00:00.000Z', sunset: '2026-08-08T14:00:00.000Z', isDaylight: true };
    const nowIso = '2026-08-08T11:00:00.000Z';
    // 同一小时/槽位，唯一差异是 daylight.isDaylight。
    const withDark = scoreActivity(walk, scoreCtx({ hour: 19, slotIndex: 19, dayIndex: 7, daylight: afterSunset }), nowIso);
    const withLight = scoreActivity(walk, scoreCtx({ hour: 19, slotIndex: 19, dayIndex: 7, daylight: beforeSunset }), nowIso);
    expect(withDark).toBe(withLight + 10);
  });
});

describe('语义事件 episode 去重（含 typo 修复与温度事件）', () => {
  /** 建 harness 并返回可推进的时钟、provider 工厂、target 与事件读取。 */
  async function setup() {
    let now = localTime('2026-08-08T10:00');
    harness = await createHarness({
      skipStickerImport: true,
      startWorkers: false,
      env: { WORLD_CONTEXT_ENABLED: 'true', LOCATION_MODEL_ENABLED: 'true', WEATHER_ENABLED: 'true' },
      clock: () => now
    });
    const weather = harness.app.services.weather;
    const location = harness.app.services.location.list().find((l) => l.kind === 'home')!;
    const target = { key: location.id };
    // 每次快照间隔推进 >120 分钟（超过 stale 窗口），强制 await refresh。
    const advance = (minutes: number): void => { now = new Date(now.getTime() + minutes * 60_000); };
    const providerFor = (condition: WeatherSnapshot['condition'], temp?: number): WeatherProviderFull => ({
      name: 'fake-event',
      configured: true,
      current: async () => fullSnapshot(condition, { temperatureC: temp, observedAt: now.toISOString() })
    });
    const weatherEvents = (): Array<{ event_type: string }> =>
      harness!.app.repos.life.events(20).filter((e) => e.event_type.startsWith('weather.'));
    return { weather, target, advance, providerFor, weatherEvents };
  }

  it('storm 事件类型为 weather.storm（修复 weather.weather.storm typo）且按 episode 去重', async () => {
    const { weather, target, advance, providerFor, weatherEvents } = await setup();
    weather.setProvider(providerFor('storm'));
    await weather.snapshotFor(target);   // weather.storm
    advance(31);
    await weather.snapshotFor(target);   // 同 episode，不再记录
    advance(31);
    await weather.snapshotFor(target);
    const events = weatherEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.event_type).toBe('weather.storm');
  });

  it('rain → clear 记录 rain_stopped；同 episode 只记一次 started_raining', async () => {
    const { weather, target, advance, providerFor, weatherEvents } = await setup();
    weather.setProvider(providerFor('rain'));
    await weather.snapshotFor(target);   // started_raining
    advance(121);
    await weather.snapshotFor(target);   // 同 episode，无新事件
    advance(121);
    weather.setProvider(providerFor('clear'));
    await weather.snapshotFor(target);   // rain_stopped

    const types = weatherEvents().map((e) => e.event_type);
    expect(types.filter((t) => t === 'weather.started_raining')).toHaveLength(1);
    expect(types.filter((t) => t === 'weather.rain_stopped')).toHaveLength(1);
  });

  it('heat_wave / cold_snap 按温度 episode 去重', async () => {
    const { weather, target, advance, providerFor, weatherEvents } = await setup();
    weather.setProvider(providerFor('clear', 36));
    await weather.snapshotFor(target);   // heat_wave
    advance(121);
    await weather.snapshotFor(target);   // 同 episode，无新事件
    advance(121);
    weather.setProvider(providerFor('clear', -12));
    await weather.snapshotFor(target);   // cold_snap

    const types = weatherEvents().map((e) => e.event_type);
    expect(types.filter((t) => t === 'weather.heat_wave')).toHaveLength(1);
    expect(types.filter((t) => t === 'weather.cold_snap')).toHaveLength(1);
  });

  it('provider 全挂（unknown 降级）不产生任何语义事件', async () => {
    const { weather, target, providerFor, weatherEvents } = await setup();
    weather.setProvider({ name: 'boom', configured: true, current: async () => { throw new Error('x'); } });
    await weather.snapshotFor(target);
    await weather.snapshotFor(target);
    expect(weatherEvents()).toHaveLength(0);
  });
});

describe('provider 故障不影响 chat', () => {
  it('weather 全挂时 chat 仍 200，天气为 unknown', async () => {
    harness = await createHarness({
      skipStickerImport: true,
      startWorkers: false,
      env: { WORLD_CONTEXT_ENABLED: 'true', LOCATION_MODEL_ENABLED: 'true', WEATHER_ENABLED: 'true' },
      chat: { script: [['好的，收到。']] }
    });
    const weather = harness.app.services.weather;
    weather.setProvider({ name: 'boom', configured: true, current: async () => { throw new Error('x'); } });
    const location = harness.app.services.location.list().find((l) => l.kind === 'home')!;
    const snapshot = await weather.snapshotFor({ key: location.id });
    expect(snapshot.condition).toBe('unknown');
    expect(snapshot.stale).toBe(true);

    const { res } = await sendText(harness.app, '你好呀');
    expect(res.statusCode).toBe(200);
  });
});
