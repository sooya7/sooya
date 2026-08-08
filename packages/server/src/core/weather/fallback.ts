import type { WeatherSnapshotRow, WeatherForecastRow, WeatherSnapshot } from '../../db/repos/weather.repo.js';
import type { WeatherLocation } from './service.js';
import { createWeatherProvider, weatherLocationKey, type WeatherProviderFull, type WeatherProviderEnv } from './provider.js';
import { forecastFromRow } from './forecast.js';
import type { WeatherForecast, DaylightSnapshot } from './forecast.js';

/**
 * FallbackWeatherProvider：primary → secondary → cached snapshot → unknown
 * 的降级链（contract §1.2）。current/forecast 的缓存腿只读 repo 最新行；
 * 降级结果带 degraded 标记，服务层不落库、不触发语义事件。链内任何一步
 * 抛错都吞掉继续下一步——provider 故障绝不影响 Life/Chat。
 */

/** 只读缓存访问器（Integration 传 WeatherRepo 或等价对象）。 */
export interface WeatherCacheReader {
  latest(locationKey: string): WeatherSnapshotRow | undefined;
  latestForecast(locationKey: string): WeatherForecastRow | undefined;
}

export interface FallbackChainOptions {
  primary?: WeatherProviderFull | null;
  secondary?: WeatherProviderFull | null;
  cache?: WeatherCacheReader | null;
  clock?: () => Date;
}

export class FallbackWeatherProvider implements WeatherProviderFull {
  readonly name = 'fallback';

  constructor(private readonly opts: FallbackChainOptions) {}

  get configured(): boolean {
    return Boolean(this.opts.primary?.configured || this.opts.secondary?.configured);
  }

  async current(location: WeatherLocation, signal?: AbortSignal): Promise<WeatherSnapshot> {
    const key = weatherLocationKey(location);
    for (const provider of [this.opts.primary, this.opts.secondary]) {
      if (!provider?.configured) continue;
      try {
        const snapshot = await provider.current(location, signal);
        return { ...snapshot, locationKey: key, stale: false };
      } catch { /* 主备都失败才降级 */ }
    }
    const cached = this.opts.cache?.latest(key);
    if (cached) {
      return {
        observedAt: cached.observed_at,
        condition: cached.condition,
        temperatureC: cached.temperature_c ?? undefined,
        feelsLikeC: cached.feels_like_c ?? undefined,
        humidity: cached.humidity ?? undefined,
        precipitationMm: cached.precipitation_mm ?? undefined,
        windKph: cached.wind_kph ?? undefined,
        visibilityKm: cached.visibility_km ?? undefined,
        pressureHpa: cached.pressure_hpa ?? undefined,
        provider: 'cache',
        locationKey: key,
        stale: true,
        degraded: true
      };
    }
    return {
      observedAt: (this.opts.clock?.() ?? new Date()).toISOString(),
      condition: 'unknown',
      provider: 'unknown',
      locationKey: key,
      stale: true,
      degraded: true
    };
  }

  async forecast(location: WeatherLocation, signal?: AbortSignal): Promise<WeatherForecast | null> {
    for (const provider of [this.opts.primary, this.opts.secondary]) {
      if (!provider?.configured || !provider.forecast) continue;
      try {
        const forecast = await provider.forecast(location, signal);
        if (forecast && forecast.periods.length > 0) return forecast;
      } catch { /* 继续降级 */ }
    }
    const cached = this.opts.cache?.latestForecast(weatherLocationKey(location));
    return cached ? forecastFromRow(cached) : null;
  }

  async daylight(location: WeatherLocation, signal?: AbortSignal): Promise<DaylightSnapshot | null> {
    for (const provider of [this.opts.primary, this.opts.secondary]) {
      if (!provider?.configured || !provider.daylight) continue;
      try {
        const daylight = await provider.daylight(location, signal);
        if (daylight) return daylight;
      } catch { /* 继续降级 */ }
    }
    return null;
  }
}

/**
 * 便捷工厂：WEATHER_PROVIDER='a,b' 组装主备链；单值则只有 primary。
 * cache 传 WeatherRepo（服务层缓存读取）。全未配置时返回 no-op。
 */
export function createWeatherChain(env: WeatherProviderEnv = {}, cache?: WeatherCacheReader | null): WeatherProviderFull {
  const names = String(env.provider ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const primary = names[0] ? createWeatherProvider({ ...env, provider: names[0] }) : null;
  const secondary = names[1] ? createWeatherProvider({ ...env, provider: names[1] }) : null;
  if (!primary && !secondary) return createWeatherProvider({ provider: '' });
  return new FallbackWeatherProvider({ primary, secondary, cache: cache ?? null, clock: env.clock });
}
