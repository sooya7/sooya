import type { WeatherCondition, WeatherForecastRow } from '../../db/repos/weather.repo.js';
import { severeWeatherKinds } from './severe.js';

/**
 * Forecast 域（contract §1.2 冻结类型）。weather_forecasts 行以 JSON 持久化
 * periods；summary 按 contract 拆 next12h（逐小时）/ next3d（每日），severe
 * 为任一时段命中 severe 类别。所有 at 均为 ISO 时刻（provider 本地时间已换算）。
 */

export interface WeatherForecastPeriod {
  at: string;                 // ISO
  condition: WeatherCondition;
  temperatureC?: number;
  precipitationMm?: number;
  windKph?: number;
  /** 逐小时或每日摘要（Agent B 本轮新增字段，用于 12h/3d 拆分）。 */
  periodKind?: 'hourly' | 'daily';
}

export interface WeatherForecast {
  locationKey: string;
  generatedAt: string;
  provider: string;
  periods: WeatherForecastPeriod[];   // 未来 12h（逐小时）+ 3 天（每日摘要）
}

export interface WeatherForecastSummary {
  generatedAt: string;
  provider: string;
  next12h: WeatherForecastPeriod[];
  next3d: WeatherForecastPeriod[];
  severe: boolean;            // storm/heavy_rain/extreme_heat/extreme_cold/snow/strong_wind
}

/** 日出/日落（ISO 时刻）+ 当前是否白昼（contract §1.2）。 */
export interface DaylightSnapshot {
  sunrise: string;            // ISO（本地时区计算）
  sunset: string;
  isDaylight: boolean;
}

/** 按 at 排序并拆成 next12h / next3d，重算 severe。 */
export function summarizeForecast(
  periods: WeatherForecastPeriod[],
  generatedAt: string,
  provider: string,
  at: Date
): WeatherForecastSummary {
  const sorted = [...periods].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  // 优先按 periodKind 拆分；无标记的旧数据回退到时间启发式。
  const hourly = sorted.filter((p) => p.periodKind !== 'daily');
  const daily = sorted.filter((p) => p.periodKind === 'daily');
  const cut = Date.parse(generatedAt) + 12 * 3_600_000;
  const next12h = hourly.length > 0 ? hourly : sorted.filter((p) => Date.parse(p.at) <= cut);
  const next3d = daily.length > 0 ? daily : sorted.filter((p) => Date.parse(p.at) > cut);
  const severe = sorted.some((p) => severeWeatherKinds(p.condition, p.temperatureC, p.windKph, p.precipitationMm).length > 0);
  return { generatedAt, provider, next12h, next3d, severe };
}

/** 持久化行 → 完整 forecast。 */
export function forecastFromRow(row: WeatherForecastRow): WeatherForecast {
  let periods: WeatherForecastPeriod[] = [];
  try { periods = JSON.parse(row.periods_json) as WeatherForecastPeriod[]; } catch { periods = []; }
  return { locationKey: row.location_key, generatedAt: row.generated_at, provider: row.provider, periods };
}

/** 持久化行 → 摘要。 */
export function forecastSummaryFromRow(row: WeatherForecastRow, at: Date): WeatherForecastSummary {
  return summarizeForecast(forecastFromRow(row).periods, row.generated_at, row.provider, at);
}

/**
 * 未来 `hours` 小时内是否存在 severe 时段（供活动评分等同步路径使用）。
 * 允许 5 分钟回看容差，避免「刚过整点」漏判。
 */
export function severeWithinHours(summary: WeatherForecastSummary, atIso: string, hours: number): boolean {
  const nowMs = Date.parse(atIso);
  const endMs = nowMs + hours * 3_600_000;
  return summary.next12h.some((p) => {
    const t = Date.parse(p.at);
    if (Number.isNaN(t) || t < nowMs - 5 * 60_000 || t > endMs) return false;
    return severeWeatherKinds(p.condition, p.temperatureC, p.windKph, p.precipitationMm).length > 0;
  });
}
