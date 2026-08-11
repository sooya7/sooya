import type { WeatherRepo, WeatherSnapshot, WeatherCondition, WeatherDaylightRow } from '../../db/repos/weather.repo.js';
import { toWeatherSnapshot } from '../../db/repos/weather.repo.js';
import type { LifeLocationRepo } from '../../db/repos/location.repo.js';
import type { LifeRepo } from '../../db/repos/life.repo.js';
import type { WeatherProviderFull } from './provider.js';
import { weatherLocationKey } from './provider.js';
import type { WeatherForecastSummary, DaylightSnapshot } from './forecast.js';
import { summarizeForecast, forecastSummaryFromRow } from './forecast.js';
import { astronomyDaylight, computeIsDaylight } from './daylight.js';
import { localDateOfIso } from '../../util/time-zone.js';

/**
 * Weather snapshot service (next phase). The provider is injected — never
 * hardcoded into the life engine. Caching: <30min fresh, 30-120min usable
 * with a background refresh, >120min stale. Provider failure degrades to the
 * latest snapshot, or 'unknown' when none exists. A failing provider never
 * blocks life or chat. 本轮扩展：完整快照字段、forecast（12h+3d）、
 * daylight（本地时区）、severe 识别与语义事件 episode 去重。
 */

export interface WeatherLocation {
  key: string;
  /** 国家（业务输入只允许 city + country；例：中国 / 宁波）。 */
  country: string;
  region?: string | null;
  city: string;
}

export interface WeatherProvider {
  name: string;
  configured: boolean;
  current(location: WeatherLocation, signal?: AbortSignal): Promise<WeatherSnapshot>;
}

export interface WeatherEventRecorder {
  record(eventType: string, description: string, meta: Record<string, unknown>): void;
}

export type { WeatherProviderFull };
export type { WeatherForecast, WeatherForecastPeriod, WeatherForecastSummary, DaylightSnapshot } from './forecast.js';
export type { SevereWeatherKind } from './severe.js';

const FRESH_MS = 30 * 60 * 1000;
const STALE_MS = 120 * 60 * 1000;
const FORECAST_FRESH_MS = 30 * 60 * 1000;

/** 事件类型固定（contract §1.2）：雨/雪/暴风按 episode 去重。 */
const RAIN_EVENT = 'weather.started_raining';
const RAIN_STOPPED_EVENT = 'weather.rain_stopped';
const SNOW_EVENT = 'weather.first_snow';
const STORM_EVENT = 'weather.storm';
const HEAT_WAVE_EVENT = 'weather.heat_wave';
const COLD_SNAP_EVENT = 'weather.cold_snap';

export class WeatherService {
  private provider: WeatherProviderFull | null = null;
  private enabled = false;
  private readonly inFlight = new Map<string, Promise<WeatherSnapshot>>();

  constructor(
    private readonly repo: WeatherRepo,
    private readonly locations: LifeLocationRepo,
    private readonly events: LifeRepo,
    private readonly clock: () => Date = () => new Date()
  ) {}

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /** Flag wiring: WEATHER_ENABLED (master WORLD_CONTEXT_ENABLED too). */
  setProvider(provider: WeatherProviderFull | null): void {
    this.provider = provider?.configured ? provider : null;
  }

  get isEnabled(): boolean {
    return this.enabled && this.provider !== null;
  }

  get providerName(): string | null {
    return this.provider?.name ?? null;
  }

  /** The location key used for caching (city/region or coordinates when present). */
  private locationKeyFor(location: WeatherLocation): string {
    return weatherLocationKey(location);
  }

  /**
   * Latest usable snapshot for a location: fresh cache, or a refresh, or the
   * last known value marked stale, or unknown. Never throws.
   */
  async snapshotFor(location: WeatherLocation, signal?: AbortSignal): Promise<WeatherSnapshot> {
    const key = this.locationKeyFor(location);
    const cached = this.repo.latest(key);
    const now = this.clock();
    if (cached) {
      const age = now.getTime() - Date.parse(cached.observed_at);
      if (age < FRESH_MS) return toWeatherSnapshot(cached, false);
      if (age < STALE_MS) {
        // Usable now; refresh in the background so the next read is fresh.
        void this.refreshNow(location, signal);
        return toWeatherSnapshot(cached, false);
      }
    }
    return this.refreshNow(location, signal);
  }

  /** Force a foreground refresh while coalescing concurrent requests per city. */
  async refreshNow(location: WeatherLocation, signal?: AbortSignal): Promise<WeatherSnapshot> {
    const key = this.locationKeyFor(location);
    const active = this.inFlight.get(key);
    if (active) return active;
    const task = this.refresh(location, signal).finally(() => {
      if (this.inFlight.get(key) === task) this.inFlight.delete(key);
    });
    this.inFlight.set(key, task);
    return task;
  }

  /** Synchronous best-known condition (life scoring path); never blocks. */
  cachedCondition(location: WeatherLocation | null): WeatherCondition | null {
    if (!this.enabled || !location) return null;
    const key = this.locationKeyFor(location);
    const cached = this.repo.latest(key);
    return cached?.condition ?? null;
  }

  /** Synchronous best-known full snapshot (world context path); never blocks. */
  cachedSnapshot(location: WeatherLocation): WeatherSnapshot | null {
    if (!this.enabled) return null;
    const cached = this.repo.latest(this.locationKeyFor(location));
    if (!cached) return null;
    const age = this.clock().getTime() - Date.parse(cached.observed_at);
    return toWeatherSnapshot(cached, age > STALE_MS);
  }

  // ------------------------------------------------------------ forecast

  /**
   * Latest usable forecast summary: fresh cache, or a refresh through the
   * provider chain, or the last cached one, or null. Never throws.
   */
  async forecastFor(location: WeatherLocation, signal?: AbortSignal): Promise<WeatherForecastSummary | null> {
    const key = this.locationKeyFor(location);
    const now = this.clock();
    const cached = this.repo.latestForecast(key);
    if (cached && now.getTime() - Date.parse(cached.generated_at) < FORECAST_FRESH_MS) {
      return forecastSummaryFromRow(cached, now);
    }
    if (!this.isEnabled) return cached ? forecastSummaryFromRow(cached, now) : null;
    try {
      const forecast = await this.provider!.forecast?.(location, signal) ?? null;
      if (forecast && forecast.periods.length > 0) {
        // 链的缓存腿返回旧 forecast（generatedAt 相同）时不再重复落库。
        if (!cached || forecast.generatedAt !== cached.generated_at) {
          this.repo.saveForecast({
            location_key: key,
            generated_at: forecast.generatedAt,
            provider: forecast.provider,
            periods_json: JSON.stringify(forecast.periods)
          });
        }
        return summarizeForecast(forecast.periods, forecast.generatedAt, forecast.provider, now);
      }
    } catch { /* 降级到缓存 */ }
    const stale = this.repo.latestForecast(key);
    return stale ? forecastSummaryFromRow(stale, now) : null;
  }

  /** Synchronous best-known forecast summary (life scoring path); never blocks. */
  cachedForecastSummary(location: WeatherLocation): WeatherForecastSummary | null {
    if (!this.enabled) return null;
    const row = this.repo.latestForecast(this.locationKeyFor(location));
    return row ? forecastSummaryFromRow(row, this.clock()) : null;
  }

  // ------------------------------------------------------------ daylight

  /**
   * Latest usable daylight: cached for the local date, else provider chain,
   * else NOAA astronomy estimate, else null. Never throws.
   */
  async daylightFor(location: WeatherLocation, at: Date = this.clock(), timeZone?: string, signal?: AbortSignal): Promise<DaylightSnapshot | null> {
    const key = this.locationKeyFor(location);
    const localDate = daylightLocalDate(at, timeZone);
    const cached = this.repo.daylightFor(key, localDate);
    if (cached) return daylightFromRow(cached, at);
    if (!this.isEnabled) return astronomyDaylight(undefined, undefined, at, timeZone, localDate);
    try {
      const daylight = await this.provider!.daylight?.(location, signal) ?? null;
      if (daylight) {
        this.repo.saveDaylight({
          location_key: key,
          local_date: localDate,
          sunrise: daylight.sunrise,
          sunset: daylight.sunset,
          provider: this.providerName ?? 'unknown'
        });
        return { ...daylight, isDaylight: computeIsDaylight(daylight.sunrise, daylight.sunset, at.toISOString()) };
      }
    } catch { /* 降级到天文估算/缺省 */ }
    return astronomyDaylight(undefined, undefined, at, timeZone, localDate);
  }

  /** Synchronous best-known daylight (life scoring path); never blocks. */
  cachedDaylight(location: WeatherLocation, at: Date = this.clock(), timeZone?: string): DaylightSnapshot | null {
    if (!this.enabled) return null;
    const key = this.locationKeyFor(location);
    const localDate = daylightLocalDate(at, timeZone);
    const row = this.repo.daylightFor(key, localDate);
    if (row) return daylightFromRow(row, at);
    return astronomyDaylight(undefined, undefined, at, timeZone, localDate);
  }

  // ------------------------------------------------------------ refresh

  /** Fetches from the provider, stores it, and records semantic transitions. */
  private async refresh(location: WeatherLocation, signal?: AbortSignal): Promise<WeatherSnapshot> {
    const key = this.locationKeyFor(location);
    if (!this.isEnabled) return unknownSnapshot(this.clock(), key);
    try {
      const snapshot = await this.provider!.current(location, signal);
      // 降级腿（cache/unknown）：不落库、不触发语义事件，直接返回。
      if (snapshot.degraded) return { ...snapshot, locationKey: key };
      this.repo.save({
        location_key: key,
        observed_at: snapshot.observedAt,
        condition: snapshot.condition,
        temperature_c: snapshot.temperatureC ?? null,
        feels_like_c: snapshot.feelsLikeC ?? null,
        humidity: snapshot.humidity ?? null,
        precipitation_mm: snapshot.precipitationMm ?? null,
        wind_kph: snapshot.windKph ?? null,
        visibility_km: snapshot.visibilityKm ?? null,
        pressure_hpa: snapshot.pressureHpa ?? null,
        provider: snapshot.provider
      });
      this.maybeRecordTransition(key, snapshot);
      return { ...snapshot, locationKey: key, stale: false };
    } catch (error) {
      // Provider failure must never block life or chat: fall back to the last
      // snapshot (stale) or unknown.
      const cached = this.repo.latest(key);
      if (cached) return toWeatherSnapshot(cached, true);
      return unknownSnapshot(this.clock(), key);
    }
  }

  // ------------------------------------------------------------ events

  /**
   * Weather events only on semantic change — never on every refresh.
   * 类型固定（contract §1.2）：started_raining / rain_stopped / first_snow /
   * storm / heat_wave / cold_snap，全部按 episode 去重（与上一行比较）。
   */
  private maybeRecordTransition(key: string, snapshot: WeatherSnapshot): void {
    const previous = this.repo.recent(key, 2)[1];
    const condition = snapshot.condition;

    // 条件转变：雨/雪/暴风开始或雨停（episode 级去重）。
    if (condition === 'rain') {
      if (!previous || previous.condition !== 'rain') {
        this.recordWeatherEvent(RAIN_EVENT, '开始下雨了', key, snapshot);
      }
    } else if (condition === 'snow') {
      if (!previous || previous.condition !== 'snow') {
        this.recordWeatherEvent(SNOW_EVENT, '下雪了', key, snapshot);
      }
    } else if (condition === 'storm') {
      if (!previous || previous.condition !== 'storm') {
        this.recordWeatherEvent(STORM_EVENT, '外面起风变天了', key, snapshot);
      }
    } else if (previous && (previous.condition === 'rain' || previous.condition === 'snow' || previous.condition === 'storm')) {
      if (previous.condition === 'rain') {
        this.recordWeatherEvent(RAIN_STOPPED_EVENT, '雨停了', key, snapshot);
      }
      // 雪停/风暴平息没有固定事件类型，不记录。
    }

    // 温度 episode：高温/严寒（阈值 35℃ / -10℃，与 severe.ts 一致）。
    const temperatureC = snapshot.temperatureC;
    if (temperatureC != null) {
      const prevTemp = previous?.temperature_c ?? null;
      if (temperatureC >= 35 && (prevTemp == null || prevTemp < 35)) {
        this.recordWeatherEvent(HEAT_WAVE_EVENT, '进入高温天', key, snapshot);
      }
      if (temperatureC <= -10 && (prevTemp == null || prevTemp > -10)) {
        this.recordWeatherEvent(COLD_SNAP_EVENT, '气温骤降，进入严寒', key, snapshot);
      }
    }
  }

  private recordWeatherEvent(eventType: string, description: string, key: string, snapshot: WeatherSnapshot): void {
    this.events.recordEvent({
      eventType,
      activity: '天气变化',
      kind: 'rest',
      description,
      happenedAt: this.clock().toISOString(),
      shareable: false,
      meta: {
        condition: snapshot.condition,
        locationKey: key,
        temperatureC: snapshot.temperatureC ?? null,
        windKph: snapshot.windKph ?? null,
        precipitationMm: snapshot.precipitationMm ?? null
      }
    });
  }
}

function unknownSnapshot(now: Date, key: string): WeatherSnapshot {
  return { observedAt: now.toISOString(), condition: 'unknown', provider: 'none', locationKey: key, stale: true };
}

function daylightLocalDate(at: Date, timeZone?: string): string {
  return timeZone ? localDateOfIso(at.toISOString(), timeZone) : at.toISOString().slice(0, 10);
}

function daylightFromRow(row: WeatherDaylightRow, at: Date): DaylightSnapshot {
  return { sunrise: row.sunrise, sunset: row.sunset, isDaylight: computeIsDaylight(row.sunrise, row.sunset, at.toISOString()) };
}
