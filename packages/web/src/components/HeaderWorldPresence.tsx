import type { WorldPresence } from '../lib/types.js';
import { formatHeaderWeather, formatPresencePlace, weatherVisual } from '../lib/worldDisplay.js';

function WeatherIcon({ condition }: { condition: string }) {
  const props = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'strokeWidth': 1.6, 'strokeLinecap': 'round' as const, 'strokeLinejoin': 'round' as const, 'aria-hidden': true };
  switch (weatherVisual(condition)) {
    case 'clear':
      return <svg {...props} data-weather-icon="clear"><circle cx="12" cy="12" r="3.5" /><path d="M12 2.5v2m0 15v2M2.5 12h2m15 0h2M5.3 5.3l1.4 1.4m10.6 10.6 1.4 1.4m0-13.4-1.4 1.4M6.7 17.3l-1.4 1.4" /></svg>;
    case 'partly-cloudy':
      return <svg {...props} data-weather-icon="partly-cloudy"><circle cx="9" cy="8" r="3" /><path d="M9 2.5v1.2m-5 4.3h1.2m8.8 0h1.2M5.5 4.5l.8.8m5.4 0 .8-.8" /><path d="M8 18h8.5a3.5 3.5 0 0 0 .3-7 4.8 4.8 0 0 0-9.7.4A3.1 3.1 0 0 0 8 18Z" /></svg>;
    case 'cloudy':
      return <svg {...props} data-weather-icon="cloudy"><path d="M6.5 17h10a4 4 0 0 0 .3-8A5.5 5.5 0 0 0 6 10.4 3.3 3.3 0 0 0 6.5 17Z" /></svg>;
    case 'drizzle':
      return <svg {...props} data-weather-icon="drizzle"><path d="M6.5 16h10a4 4 0 0 0 .3-8A5.5 5.5 0 0 0 6 9.4 3.3 3.3 0 0 0 6.5 16Z" /><path d="m9 18-.5 1.5m5-1.5L13 19.5" /></svg>;
    case 'rain':
      return <svg {...props} data-weather-icon="rain"><path d="M6.5 16h10a4 4 0 0 0 .3-8A5.5 5.5 0 0 0 6 9.4 3.3 3.3 0 0 0 6.5 16Z" /><path d="m8 18-1 3m5-3-1 3m5-3-1 3" /></svg>;
    case 'storm':
      return <svg {...props} data-weather-icon="storm"><path d="M6.5 15.5h10a4 4 0 0 0 .3-8A5.5 5.5 0 0 0 6 8.9a3.3 3.3 0 0 0 .5 6.6Z" /><path d="m13 14-2 4h2l-1 4 4-6h-2l2-3" /></svg>;
    case 'snow':
      return <svg {...props} data-weather-icon="snow"><path d="M6.5 15.5h10a4 4 0 0 0 .3-8A5.5 5.5 0 0 0 6 8.9a3.3 3.3 0 0 0 .5 6.6Z" /><path d="M9 18v5m-2.2-2.5h4.4M7.4 19.6l3.2 2.8m0-2.8-3.2 2.8" /></svg>;
    case 'fog':
      return <svg {...props} data-weather-icon="fog"><path d="M4 9h13M2.5 13h19M5 17h12" /></svg>;
    case 'haze':
      return <svg {...props} data-weather-icon="haze"><circle cx="9" cy="8" r="3" /><path d="M9 2.5v1.2m-5 4.3h1.2m8.8 0h1.2M5.5 4.5l.8.8m5.4 0 .8-.8M4 16h16M6 20h12" /></svg>;
    case 'wind':
      return <svg {...props} data-weather-icon="wind"><path d="M3 8h11a2.5 2.5 0 1 0-2.4-3.2M3 12h16a2.5 2.5 0 1 1-2.4 3.2M3 16h8" /></svg>;
    case 'extreme-heat':
      return <svg {...props} data-weather-icon="extreme-heat"><circle cx="9" cy="8" r="3" /><path d="M9 2.5v1.2m-5 4.3h1.2m8.8 0h1.2M5.5 4.5l.8.8m5.4 0 .8-.8M15 16c-1 1-1 2 0 3m4-3c-1 1-1 2 0 3" /></svg>;
    case 'extreme-cold':
      return <svg {...props} data-weather-icon="extreme-cold"><path d="M12 3v18m-7.8-13.5 15.6 9m0-9-15.6 9M7.5 5.6 12 8.2l4.5-2.6M7.5 18.4 12 15.8l4.5 2.6" /></svg>;
    default:
      return null;
  }
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
