import type { WeatherCondition } from '../../db/repos/weather.repo.js';

/**
 * Severe weather 识别（contract §1.2）。六类：storm / heavy_rain / extreme_heat /
 * extreme_cold / snow / strong_wind。判定规则是保守的阈值组合——只有 provider
 * 真实返回的数据（温度/降水/风速）够格才标记，绝不虚构。severe 只用于
 * 影响活动计划、出行摩擦与地点选择；不制造夸张情绪。
 */

export type SevereWeatherKind =
  | 'storm'
  | 'heavy_rain'
  | 'extreme_heat'
  | 'extreme_cold'
  | 'snow'
  | 'strong_wind';

const EXTREME_HEAT_C = 35;
const EXTREME_COLD_C = -10;
const HEAVY_RAIN_MM = 10;   // 单小时降水 ≥10mm 视为暴雨
const STRONG_WIND_KPH = 60; // ≥8 级风

/** 一个条件/温度/降水/风速组合命中的 severe 类别（可为空数组）。 */
export function severeWeatherKinds(
  condition: WeatherCondition,
  temperatureC?: number | null,
  windKph?: number | null,
  precipitationMm?: number | null
): SevereWeatherKind[] {
  const kinds: SevereWeatherKind[] = [];
  if (condition === 'storm') kinds.push('storm');
  if (condition === 'snow') kinds.push('snow');
  if (condition === 'rain' && (precipitationMm ?? 0) >= HEAVY_RAIN_MM) kinds.push('heavy_rain');
  if (temperatureC != null && temperatureC >= EXTREME_HEAT_C) kinds.push('extreme_heat');
  if (temperatureC != null && temperatureC <= EXTREME_COLD_C) kinds.push('extreme_cold');
  if (windKph != null && windKph >= STRONG_WIND_KPH) kinds.push('strong_wind');
  return kinds;
}

/** 人类可读标签（上下文行/事件描述用）。 */
export function severeLabel(kind: SevereWeatherKind): string {
  switch (kind) {
    case 'storm': return '暴风雨';
    case 'heavy_rain': return '暴雨';
    case 'extreme_heat': return '极端高温';
    case 'extreme_cold': return '极端低温';
    case 'snow': return '下雪';
    case 'strong_wind': return '大风';
  }
}
