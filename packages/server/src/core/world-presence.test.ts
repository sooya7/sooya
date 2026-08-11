import { describe, expect, it } from 'vitest';
import { presenceFingerprint, type WorldPresence } from './world-presence.js';

function presence(over: Partial<WorldPresence> = {}): WorldPresence {
  return {
    city: { id: 'city-1', name: '宁波', region: '浙江', country: '中国' },
    location: { id: 'loc-1', name: '家', kind: 'home' },
    travel: null,
    weather: { condition: 'cloudy', temperatureC: 26.1, feelsLikeC: 27.1, observedAt: '2026-08-11T00:00:00.000Z', stale: false, provider: 'test' },
    updatedAt: '2026-08-11T00:00:00.000Z',
    ...over
  };
}

describe('WorldPresence fingerprint', () => {
  it('ignores timestamps and sub-degree temperature noise', () => {
    const first = presence();
    const second = presence({
      weather: { ...first.weather!, temperatureC: 26.4, observedAt: '2026-08-11T00:01:00.000Z' },
      updatedAt: '2026-08-11T00:01:00.000Z'
    });
    expect(presenceFingerprint(first)).toBe(presenceFingerprint(second));
  });

  it('changes when a header-visible semantic value changes', () => {
    expect(presenceFingerprint(presence())).not.toBe(presenceFingerprint(presence({
      weather: { ...presence().weather!, temperatureC: 27.1 }
    })));
  });
});
