import type { WorldPresence } from './types.js';
import { formatTemperature } from './numberDisplay.js';

const WEATHER_LABELS: Record<string, string> = {
  clear: '晴',
  cloudy: '多云',
  rain: '雨',
  snow: '雪',
  storm: '雷暴',
  fog: '雾',
  wind: '大风',
  partly_cloudy: '多云',
  drizzle: '小雨',
  haze: '有霾',
  extreme_heat: '酷热',
  extreme_cold: '严寒'
};

export type WeatherVisual =
  | 'clear'
  | 'partly-cloudy'
  | 'cloudy'
  | 'drizzle'
  | 'rain'
  | 'storm'
  | 'snow'
  | 'fog'
  | 'haze'
  | 'wind'
  | 'extreme-heat'
  | 'extreme-cold'
  | 'unknown';

export function weatherVisual(condition: string): WeatherVisual {
  switch (condition) {
    case 'clear': return 'clear';
    case 'partly_cloudy': return 'partly-cloudy';
    case 'cloudy': return 'cloudy';
    case 'drizzle': return 'drizzle';
    case 'rain': return 'rain';
    case 'storm': return 'storm';
    case 'snow': return 'snow';
    case 'fog': return 'fog';
    case 'haze': return 'haze';
    case 'wind': return 'wind';
    case 'extreme_heat': return 'extreme-heat';
    case 'extreme_cold': return 'extreme-cold';
    default: return 'unknown';
  }
}

/** Chat header intentionally shows the concrete place only; city is redundant here. */
export function formatPresencePlace(presence: WorldPresence | null): string | null {
  if (!presence) return null;
  return presence.travel
    ? (presence.travel.toName ? `去${presence.travel.toName}路上` : '路上')
    : presence.location?.name ?? null;
}

export function formatHeaderWeather(weather: WorldPresence['weather']): string | null {
  if (!weather || weather.condition === 'unknown') return null;
  const label = WEATHER_LABELS[weather.condition] ?? weather.condition;
  const temperature = weather.temperatureC == null ? null : formatTemperature(weather.temperatureC);
  return [temperature, label].filter(Boolean).join(' ') || null;
}

export function weatherConditionLabel(condition: string): string {
  return WEATHER_LABELS[condition] ?? condition;
}
