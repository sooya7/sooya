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
  provider: string;
  created_at: string;
}

/** The snapshot shape consumed by services (stale flag computed by the service). */
export interface WeatherSnapshot {
  observedAt: string;
  condition: WeatherCondition;
  temperatureC?: number;
  feelsLikeC?: number;
  humidity?: number;
  precipitationMm?: number;
  windKph?: number;
  provider: string;
  locationKey: string;
  stale: boolean;
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
    provider: row.provider,
    locationKey: row.location_key,
    stale
  };
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
      INSERT INTO weather_snapshots(location_key, observed_at, condition, temperature_c, feels_like_c, humidity, precipitation_mm, wind_kph, provider, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(row.location_key, row.observed_at, row.condition, row.temperature_c, row.feels_like_c, row.humidity, row.precipitation_mm, row.wind_kph, row.provider, row.created_at);
    return row;
  }

  recent(locationKey: string, limit = 20): WeatherSnapshotRow[] {
    return this.db.prepare(
      'SELECT * FROM weather_snapshots WHERE location_key = ? ORDER BY observed_at DESC LIMIT ?'
    ).all(locationKey, Math.max(1, Math.min(100, limit))) as WeatherSnapshotRow[];
  }
}
