import type { DbLike } from '../handle.js';
import { nowIso } from '../../util/ids.js';

export type WeatherCondition = 'clear' | 'cloudy' | 'rain' | 'snow' | 'storm' | 'fog' | 'wind' | 'unknown';

export interface WeatherSnapshotRow {
  location_key: string;
  observed_at: string;
  condition: WeatherCondition;
  temperature_c: number | null;
  feels_like_c: number | null;
  humidity: number | null;
  precipitation_mm: number | null;
  wind_kph: number | null;
  visibility_km: number | null;
  pressure_hpa: number | null;
  provider: string;
  created_at: string;
}

/**
 * The snapshot shape consumed by services (stale flag computed by the service).
 * 冻结字段（contract §1.2）之上只增：visibilityKm/pressureHpa 为完整字段；
 * degraded 由 FallbackWeatherProvider 的降级腿（cache/unknown）标记，服务不落库。
 */
export interface WeatherSnapshot {
  observedAt: string;
  condition: WeatherCondition;
  temperatureC?: number;
  feelsLikeC?: number;
  humidity?: number;
  precipitationMm?: number;
  windKph?: number;
  visibilityKm?: number;
  pressureHpa?: number;
  provider: string;
  locationKey: string;
  stale: boolean;
  /** 降级快照（缓存/未知），只读不落库、不触发语义事件。 */
  degraded?: boolean;
}

export function toWeatherSnapshot(row: WeatherSnapshotRow, stale: boolean): WeatherSnapshot {
  return {
    observedAt: row.observed_at,
    condition: row.condition,
    temperatureC: row.temperature_c ?? undefined,
    feelsLikeC: row.feels_like_c ?? undefined,
    humidity: row.humidity ?? undefined,
    precipitationMm: row.precipitation_mm ?? undefined,
    windKph: row.wind_kph ?? undefined,
    visibilityKm: row.visibility_km ?? undefined,
    pressureHpa: row.pressure_hpa ?? undefined,
    provider: row.provider,
    locationKey: row.location_key,
    stale
  };
}

/** 持久化的 forecast 行（periods 以 JSON 存储，结构见 core/weather/forecast.ts）。 */
export interface WeatherForecastRow {
  location_key: string;
  generated_at: string;
  provider: string;
  periods_json: string;
  created_at: string;
}

/** 持久化的 daylight 行：按（location_key, 本地日期）一行的日升日落。 */
export interface WeatherDaylightRow {
  location_key: string;
  local_date: string;
  sunrise: string;
  sunset: string;
  provider: string;
  created_at: string;
}

export class WeatherRepo {
  constructor(private readonly db: DbLike) {}

  latest(locationKey: string): WeatherSnapshotRow | undefined {
    return this.db.prepare(
      'SELECT * FROM weather_snapshots WHERE location_key = ? ORDER BY observed_at DESC LIMIT 1'
    ).get(locationKey) as WeatherSnapshotRow | undefined;
  }

  save(snapshot: Omit<WeatherSnapshotRow, 'created_at'>): WeatherSnapshotRow {
    const row: WeatherSnapshotRow = { ...snapshot, created_at: nowIso() };
    this.db.prepare(`
      INSERT INTO weather_snapshots(location_key, observed_at, condition, temperature_c, feels_like_c, humidity, precipitation_mm, wind_kph, visibility_km, pressure_hpa, provider, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(row.location_key, row.observed_at, row.condition, row.temperature_c, row.feels_like_c, row.humidity, row.precipitation_mm, row.wind_kph, row.visibility_km, row.pressure_hpa, row.provider, row.created_at);
    return row;
  }

  recent(locationKey: string, limit = 20): WeatherSnapshotRow[] {
    return this.db.prepare(
      'SELECT * FROM weather_snapshots WHERE location_key = ? ORDER BY observed_at DESC LIMIT ?'
    ).all(locationKey, Math.max(1, Math.min(100, limit))) as WeatherSnapshotRow[];
  }

  // ---- forecast ----

  latestForecast(locationKey: string): WeatherForecastRow | undefined {
    return this.db.prepare(
      'SELECT * FROM weather_forecasts WHERE location_key = ? ORDER BY generated_at DESC LIMIT 1'
    ).get(locationKey) as WeatherForecastRow | undefined;
  }

  saveForecast(input: Omit<WeatherForecastRow, 'created_at'>): WeatherForecastRow {
    const row: WeatherForecastRow = { ...input, created_at: nowIso() };
    this.db.prepare(`
      INSERT INTO weather_forecasts(location_key, generated_at, provider, periods_json, created_at)
      VALUES (?,?,?,?,?)
    `).run(row.location_key, row.generated_at, row.provider, row.periods_json, row.created_at);
    return row;
  }

  // ---- daylight ----

  daylightFor(locationKey: string, localDate: string): WeatherDaylightRow | undefined {
    return this.db.prepare(
      'SELECT * FROM weather_daylight WHERE location_key = ? AND local_date = ?'
    ).get(locationKey, localDate) as WeatherDaylightRow | undefined;
  }

  saveDaylight(input: Omit<WeatherDaylightRow, 'created_at'>): WeatherDaylightRow {
    const row: WeatherDaylightRow = { ...input, created_at: nowIso() };
    this.db.prepare(`
      INSERT INTO weather_daylight(location_key, local_date, sunrise, sunset, provider, created_at)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT(location_key, local_date) DO UPDATE SET sunrise=excluded.sunrise, sunset=excluded.sunset, provider=excluded.provider, created_at=excluded.created_at
    `).run(row.location_key, row.local_date, row.sunrise, row.sunset, row.provider, row.created_at);
    return row;
  }
}
