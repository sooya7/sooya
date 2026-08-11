// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { HeaderWorldPresence } from './HeaderWorldPresence.js';
import type { WorldPresence } from '../lib/types.js';

const base: WorldPresence = {
  city: { id: 'city-1', name: '宁波' },
  location: { id: 'location-1', name: '家', kind: 'home' },
  travel: null,
  weather: { condition: 'cloudy', temperatureC: 26, feelsLikeC: null, observedAt: '2026-08-11T00:00:00.000Z', stale: false, provider: 'test' },
  updatedAt: '2026-08-11T00:00:00.000Z'
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function render(condition: string, stale = false): Element | null {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root!.render(<HeaderWorldPresence presence={{ ...base, weather: { ...base.weather!, condition: condition as never, stale } }} />);
  });
  return container.querySelector('[data-weather-icon]');
}

describe('HeaderWorldPresence weather icons', () => {
  it.each([
    ['clear', 'clear'],
    ['partly_cloudy', 'partly-cloudy'],
    ['cloudy', 'cloudy'],
    ['drizzle', 'drizzle'],
    ['rain', 'rain'],
    ['storm', 'storm'],
    ['snow', 'snow'],
    ['fog', 'fog'],
    ['haze', 'haze'],
    ['wind', 'wind'],
    ['extreme_heat', 'extreme-heat'],
    ['extreme_cold', 'extreme-cold']
  ] as const)('renders the %s icon', (condition, visual) => {
    expect(render(condition)?.getAttribute('data-weather-icon')).toBe(visual);
  });

  it('does not invent an icon for unknown weather', () => {
    expect(render('unknown')).toBeNull();
    expect(container?.querySelector('[data-testid="world-presence-place"]')).not.toBeNull();
    expect(container?.querySelector('[data-testid="world-presence-weather"]')).toBeNull();
  });

  it('keeps the real icon while marking stale weather', () => {
    expect(render('rain', true)?.getAttribute('data-weather-icon')).toBe('rain');
    expect(container?.querySelector('.topbar-world')?.classList.contains('is-stale')).toBe(true);
  });
});
