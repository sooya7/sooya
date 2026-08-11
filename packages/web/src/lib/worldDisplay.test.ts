import { describe, expect, it } from 'vitest';
import { formatHeaderWeather, formatPresencePlace } from './worldDisplay.js';
import { formatTemperature, formatVital } from './numberDisplay.js';
import type { WorldPresence } from './types.js';

const base: WorldPresence = {
  city: { id: 'city-1', name: '宁波' },
  location: { id: 'loc-1', name: '家', kind: 'home' },
  travel: null,
  weather: { condition: 'cloudy', temperatureC: 26.3, feelsLikeC: null, observedAt: '2026-08-11T00:00:00.000Z', stale: false, provider: 'test' },
  updatedAt: '2026-08-11T00:00:00.000Z'
};

describe('world display formatters', () => {
  it('shows city and current place, or the travel destination', () => {
    expect(formatPresencePlace(base)).toBe('宁波 · 家');
    expect(formatPresencePlace({ ...base, travel: { fromLocationId: 'loc-1', fromName: '家', toLocationId: 'loc-2', toName: '咖啡店', mode: 'walk', expectedArriveAt: '2026-08-11T01:00:00.000Z' } })).toBe('宁波 · 去咖啡店路上');
  });

  it('rounds header temperatures and hides unknown weather', () => {
    expect(formatHeaderWeather(base.weather)).toBe('26°C 多云');
    expect(formatHeaderWeather({ ...base.weather!, condition: 'unknown' })).toBeNull();
    expect(formatTemperature(26.6)).toBe('27°C');
    expect(formatVital('sleep_debt', 1.537)).toBe('1.5 小时');
  });
});
