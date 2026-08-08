import type { WeatherSnapshot, WeatherCondition } from '../../db/repos/weather.repo.js';
import type { WeatherLocation, WeatherProvider } from './service.js';
import type { WeatherForecast, WeatherForecastPeriod, DaylightSnapshot } from './forecast.js';
import { computeIsDaylight } from './daylight.js';
import { combineAbortSignals } from '../../util/abort.js';
import { localDateTimeToUtc } from '../../util/time-zone.js';

/**
 * Provider 层（contract §1.2）：`WeatherProvider` 现状冻结，扩展能力
 * （forecast / daylight）走 `WeatherProviderFull`。`createWeatherProvider`
 * 工厂按 WEATHER_PROVIDER 选择真实适配器；未配置/未知名称返回
 * configured=false 的 no-op，绝不伪装成功。open-meteo 免费无 key，作为
 * primary 类型之一（需要坐标，city/region 文本无法查询）。
 */

/** 现状 WeatherProvider + 可选 forecast/daylight（本轮新增，Agent B 定义）。 */
export interface WeatherProviderFull extends WeatherProvider {
  forecast?(location: WeatherLocation, signal?: AbortSignal): Promise<WeatherForecast | null>;
  daylight?(location: WeatherLocation, signal?: AbortSignal): Promise<DaylightSnapshot | null>;
}

export interface WeatherProviderEnv {
  /** WEATHER_PROVIDER：如 'open-meteo'（'a,b' 表示主备链，见 fallback.ts）。 */
  provider?: string | null;
  /** WEATHER_BASE_URL：适配器 API 根地址。 */
  baseUrl?: string | null;
  /** WEATHER_API_KEY：需要 key 的 provider 使用（open-meteo 不需要）。 */
  apiKey?: string | null;
  /** WEATHER_TIMEOUT_MS，默认 5000。 */
  timeoutMs?: number;
  /** 测试注入。 */
  fetchImpl?: typeof fetch;
  clock?: () => Date;
}

export const DEFAULT_WEATHER_TIMEOUT_MS = 5000;

/** 规范化缓存 key（与 service 的 locationKeyFor 逻辑一致）。 */
export function weatherLocationKey(location: WeatherLocation): string {
  if (location.key) return location.key;
  if (location.lat != null && location.lng != null) return `${Math.round(location.lat * 10)},${Math.round(location.lng * 10)}`;
  return location.city ?? location.region ?? 'unknown';
}

const NOOP_WEATHER_PROVIDER: WeatherProviderFull = {
  name: 'none',
  configured: false,
  current: async () => {
    throw new Error('weather provider not configured');
  }
};

/**
 * 工厂：按 WEATHER_PROVIDER 名创建单个适配器。未配置或未知名称返回
 * configured=false 的 no-op（服务端 setProvider 会将其视为 null）。
 */
export function createWeatherProvider(env: WeatherProviderEnv = {}): WeatherProviderFull {
  const name = String(env.provider ?? '').trim().toLowerCase();
  const common = {
    baseUrl: env.baseUrl ?? undefined,
    timeoutMs: env.timeoutMs ?? DEFAULT_WEATHER_TIMEOUT_MS,
    fetchImpl: env.fetchImpl,
    clock: env.clock
  };
  if (name === 'open-meteo') return new OpenMeteoWeatherProvider(common);
  return NOOP_WEATHER_PROVIDER;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** WMO weather code → 语义 condition。 */
export function wmoCondition(code: number | null | undefined): WeatherCondition {
  if (code == null) return 'unknown';
  if (code === 0) return 'clear';
  if (code >= 1 && code <= 3) return 'cloudy';
  if (code === 45 || code === 48) return 'fog';
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  if (code >= 95 && code <= 99) return 'storm';
  return 'unknown';
}

/** open-meteo 返回的本地钟面时间 → ISO 时刻（带响应里的时区/UTC 偏移换算）。 */
function parseLocalIso(time: string, tz: string | undefined, utcOffsetSeconds: number | undefined): Date {
  const m = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2}))?/.exec(time);
  if (!m) return new Date(time);
  // 本地 = UTC + offset → 固定偏移回退参数取 -offset（见 util/time-zone 注释）。
  const fallbackMinutes = -((utcOffsetSeconds ?? 0) / 60);
  return localDateTimeToUtc(m[1]!, m[2] ? Number(m[2]) : 12, m[3] ? Number(m[3]) : 0, tz, fallbackMinutes);
}

interface OpenMeteoResponse {
  timezone?: string;
  utc_offset_seconds?: number;
  current?: Record<string, number | string | null | undefined>;
  hourly?: { time?: unknown[] } & Record<string, Array<number | string | null> | undefined>;
  daily?: { time?: unknown[] } & Record<string, Array<number | string | null> | undefined>;
}

/** 真实生产适配器：open-meteo（免费、无 key、无需注册）。 */
export class OpenMeteoWeatherProvider implements WeatherProviderFull {
  readonly name = 'open-meteo';
  readonly configured = true;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly clock: () => Date;

  constructor(opts: { baseUrl?: string; timeoutMs?: number; fetchImpl?: typeof fetch; clock?: () => Date } = {}) {
    this.baseUrl = String(opts.baseUrl ?? 'https://api.open-meteo.com').replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_WEATHER_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.clock = opts.clock ?? (() => new Date());
  }

  private coords(location: WeatherLocation): { lat: number; lng: number } {
    if (location.lat == null || location.lng == null) {
      throw new Error('open-meteo: 需要坐标（lat/lng）才能查询');
    }
    return { lat: location.lat, lng: location.lng };
  }

  private async getJson(url: string, signal?: AbortSignal): Promise<OpenMeteoResponse> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`weather provider timed out after ${this.timeoutMs}ms`)),
      this.timeoutMs
    );
    const combined = combineAbortSignals([signal, controller.signal]);
    try {
      const res = await this.fetchImpl(url, { signal: combined, headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`weather provider http ${res.status}`);
      return await (res.json() as Promise<OpenMeteoResponse>);
    } finally {
      clearTimeout(timer);
    }
  }

  async current(location: WeatherLocation, signal?: AbortSignal): Promise<WeatherSnapshot> {
    const { lat, lng } = this.coords(location);
    const url = `${this.baseUrl}/v1/forecast?latitude=${lat}&longitude=${lng}` +
      '&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,visibility,pressure_msl&timezone=auto';
    const json = await this.getJson(url, signal);
    const c = json.current;
    if (!c) throw new Error('open-meteo: 响应缺少 current 数据');
    const visibility = num(c.visibility);
    return {
      observedAt: parseLocalIso(String(c.time ?? ''), json.timezone, json.utc_offset_seconds).toISOString(),
      condition: wmoCondition(c.weather_code as number | null | undefined),
      temperatureC: num(c.temperature_2m),
      feelsLikeC: num(c.apparent_temperature),
      humidity: num(c.relative_humidity_2m),
      precipitationMm: num(c.precipitation),
      windKph: num(c.wind_speed_10m),
      visibilityKm: visibility != null ? Math.round(visibility / 1000) : undefined,
      pressureHpa: num(c.pressure_msl),
      provider: this.name,
      locationKey: weatherLocationKey(location),
      stale: false
    };
  }

  async forecast(location: WeatherLocation, signal?: AbortSignal): Promise<WeatherForecast | null> {
    const { lat, lng } = this.coords(location);
    const url = `${this.baseUrl}/v1/forecast?latitude=${lat}&longitude=${lng}` +
      '&hourly=temperature_2m,precipitation,weather_code,wind_speed_10m' +
      '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum&forecast_days=3&timezone=auto';
    const json = await this.getJson(url, signal);
    const hourly = json.hourly ?? {};
    const daily = json.daily ?? {};
    const tz = json.timezone;
    const off = json.utc_offset_seconds;
    const periods: WeatherForecastPeriod[] = [];
    const hTimes = (hourly.time ?? []) as string[];
    for (let i = 0; i < Math.min(12, hTimes.length); i++) {
      periods.push({
        at: parseLocalIso(String(hTimes[i]), tz, off).toISOString(),
        condition: wmoCondition(hourly.weather_code?.[i] as number | null | undefined),
        temperatureC: num(hourly.temperature_2m?.[i]),
        precipitationMm: num(hourly.precipitation?.[i]),
        windKph: num(hourly.wind_speed_10m?.[i]),
        periodKind: 'hourly'
      });
    }
    const dTimes = (daily.time ?? []) as string[];
    for (let i = 0; i < Math.min(3, dTimes.length); i++) {
      periods.push({
        at: parseLocalIso(`${String(dTimes[i])}T12:00`, tz, off).toISOString(),
        condition: wmoCondition(daily.weather_code?.[i] as number | null | undefined),
        temperatureC: num(daily.temperature_2m_max?.[i]) ?? num(daily.temperature_2m_min?.[i]),
        precipitationMm: num(daily.precipitation_sum?.[i]),
        periodKind: 'daily'
      });
    }
    if (periods.length === 0) return null;
    return { locationKey: weatherLocationKey(location), generatedAt: this.clock().toISOString(), provider: this.name, periods };
  }

  async daylight(location: WeatherLocation, signal?: AbortSignal): Promise<DaylightSnapshot | null> {
    const { lat, lng } = this.coords(location);
    const url = `${this.baseUrl}/v1/forecast?latitude=${lat}&longitude=${lng}` +
      '&daily=sunrise,sunset&forecast_days=1&timezone=auto';
    const json = await this.getJson(url, signal);
    const daily = json.daily ?? {};
    if (!daily.sunrise?.length || !daily.sunset?.length) return null;
    const sunrise = parseLocalIso(String(daily.sunrise[0]), json.timezone, json.utc_offset_seconds).toISOString();
    const sunset = parseLocalIso(String(daily.sunset[0]), json.timezone, json.utc_offset_seconds).toISOString();
    const now = this.clock();
    return { sunrise, sunset, isDaylight: computeIsDaylight(sunrise, sunset, now.toISOString()) };
  }
}
