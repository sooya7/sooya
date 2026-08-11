import type { WorldPresence } from '../lib/types.js';
import { formatHeaderWeather, formatPresencePlace } from '../lib/worldDisplay.js';

function WeatherIcon({ condition }: { condition: string }) {
  if (condition === 'rain' || condition === 'drizzle' || condition === 'storm') {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17h9a4 4 0 0 0 .4-8A5.5 5.5 0 0 0 6 10.4 3.3 3.3 0 0 0 7 17Z" /><path d="m9 19-1 2m5-2-1 2m5-2-1 2" /></svg>;
  }
  if (condition === 'clear') {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.5" /><path d="M12 2.5v2m0 15v2M2.5 12h2m15 0h2M5.3 5.3l1.4 1.4m10.6 10.6 1.4 1.4m0-13.4-1.4 1.4M6.7 17.3l-1.4 1.4" /></svg>;
  }
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 17h10a4 4 0 0 0 .3-8A5.5 5.5 0 0 0 6 10.4 3.3 3.3 0 0 0 6.5 17Z" /></svg>;
}

export function HeaderWorldPresence({ presence }: { presence: WorldPresence | null }) {
  const place = formatPresencePlace(presence);
  const weather = formatHeaderWeather(presence?.weather ?? null);
  if (!place && !weather) return null;
  const stale = Boolean(presence?.weather?.stale);
  return (
    <div className={`topbar-world${stale ? ' is-stale stale' : ''}`} data-testid="world-presence" title={stale ? '天气数据较旧，正在尝试更新' : undefined}>
      {place && <div className="topbar-world-line" data-testid="world-presence-place"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s6-5.2 6-11a6 6 0 1 0-12 0c0 5.8 6 11 6 11Z" /><circle cx="12" cy="10" r="2" /></svg><span>{place}</span></div>}
      {weather && <div className={`topbar-world-line topbar-world-weather${stale ? ' is-stale' : ''}`} data-testid="world-presence-weather" title={stale ? '天气数据较旧，正在尝试更新' : undefined}><WeatherIcon condition={presence?.weather?.condition ?? 'cloudy'} /><span>{weather}</span></div>}
    </div>
  );
}
