import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { adminApi, type AdminLifeOverview, type AdminLifeVitals } from '../../lib/admin.js';
import type { LifePanelData } from '../../lib/features.js';
import { mergeLifeHistory, type LifeHistoryItem } from '../../lib/lifeObservation.js';
import { formatTemperature, formatVital } from '../../lib/numberDisplay.js';
import { weatherConditionLabel } from '../../lib/worldDisplay.js';

type LoadState<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: T }
  | { status: 'error'; message: string };

type EnvironmentData = {
  locations: Awaited<ReturnType<typeof adminApi.lifeLocations>>;
  cities: Awaited<ReturnType<typeof adminApi.lifeCities>>;
  travel: Awaited<ReturnType<typeof adminApi.lifeTravel>>;
  weather: Awaited<ReturnType<typeof adminApi.weatherStatus>>;
  forecast: Awaited<ReturnType<typeof adminApi.weatherForecast>>;
};

const VITAL_FIELDS: Array<{ key: keyof AdminLifeVitals; label: string }> = [
  { key: 'energy', label: '精力' },
  { key: 'hunger', label: '饥饿' },
  { key: 'stress', label: '压力' },
  { key: 'social_need', label: '社交需求' },
  { key: 'loneliness', label: '孤独感' },
  { key: 'curiosity', label: '好奇心' },
  { key: 'comfort', label: '舒适度' },
  { key: 'focus', label: '专注度' },
  { key: 'sleep_debt', label: '睡眠债' }
];

const TRAVEL_LABELS: Record<string, string> = {
  walk: '步行',
  bike: '骑行',
  transit: '公共交通',
  car: '汽车',
  unknown: '未知'
};

const HISTORY_LABELS: Record<LifeHistoryItem['kind'], string> = {
  activity: '活动',
  event: '事件',
  proactive: '主动联系'
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function useLazyData<T>(loader: () => Promise<T>) {
  const [state, setState] = useState<LoadState<T>>({ status: 'idle' });
  const mountedRef = useRef(false);
  const requestGenerationRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestGenerationRef.current += 1;
    };
  }, []);

  const load = useCallback(() => {
    const requestGeneration = ++requestGenerationRef.current;
    setState({ status: 'loading' });
    void Promise.resolve()
      .then(loader)
      .then((nextData) => {
        if (mountedRef.current && requestGenerationRef.current === requestGeneration) {
          setState({ status: 'success', data: nextData });
        }
      })
      .catch((error: unknown) => {
        if (mountedRef.current && requestGenerationRef.current === requestGeneration) {
          setState({ status: 'error', message: errorText(error) });
        }
      });
  }, [loader]);

  return { state, load };
}

interface DisclosureSectionProps {
  id: string;
  title: string;
  summary: string;
  onFirstOpen?: () => void;
  children: ReactNode;
}

export function DisclosureSection({ id, title, summary, onFirstOpen, children }: DisclosureSectionProps) {
  const [open, setOpen] = useState(false);
  const openedRef = useRef(false);
  const toggleId = `${id}-toggle`;

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !openedRef.current) {
      openedRef.current = true;
      onFirstOpen?.();
    }
  };

  return (
    <section className="life-detail-disclosure">
      <button
        id={toggleId}
        type="button"
        className="life-disclosure-toggle"
        aria-expanded={open}
        aria-controls={id}
        onClick={toggle}
      >
        <span>{title}</span>
        <small>{summary}</small>
        <span aria-hidden="true">{open ? '−' : '＋'}</span>
      </button>
      <div id={id} role="region" aria-labelledby={toggleId} hidden={!open}>
        {open ? children : null}
      </div>
    </section>
  );
}

function RemoteState<T>({
  state,
  loadingText,
  onRetry,
  children
}: {
  state: LoadState<T>;
  loadingText: string;
  onRetry: () => void;
  children: (data: T) => ReactNode;
}) {
  if (state.status === 'idle' || state.status === 'loading') {
    return <p role="status">{loadingText}</p>;
  }
  if (state.status === 'error') {
    return (
      <div role="alert">
        <p>{state.message}</p>
        <button type="button" onClick={onRetry}>重试</button>
      </div>
    );
  }
  return children(state.data);
}

function VitalsDetails({ vitals }: { vitals: AdminLifeVitals | null }) {
  if (!vitals) return <p>暂无身体与节律数据。</p>;
  return (
    <dl className="life-vitals-readonly">
      {VITAL_FIELDS.map(({ key, label }) => (
        <div key={key}>
          <dt>{label}</dt>
          <dd>{formatVital(key, vitals[key])}</dd>
        </div>
      ))}
    </dl>
  );
}

function locationName(id: string, environment: EnvironmentData): string {
  return environment.locations.locations.find((location) => location.id === id)?.name ?? id;
}

function ForecastDetails({ title, periods }: {
  title: string;
  periods: NonNullable<EnvironmentData['forecast']['forecast']>['next12h'];
}) {
  return (
    <div>
      <h5>{title}</h5>
      {periods.length ? (
        <ul>
          {periods.map((period) => (
            <li key={period.at}>
              <time dateTime={period.at}>{period.at}</time>
              {' · '}{weatherConditionLabel(period.condition)}
              {period.temperatureC == null ? '' : ` · ${formatTemperature(period.temperatureC)}`}
            </li>
          ))}
        </ul>
      ) : <p>暂无预报。</p>}
    </div>
  );
}

function EnvironmentDetails({ environment, overview }: {
  environment: EnvironmentData;
  overview: AdminLifeOverview;
}) {
  const activeLocation = environment.locations.current;
  const activeCities = environment.cities.cities.filter((city) => city.active);
  const travel = environment.travel.travel;
  const weather = environment.weather.lastSnapshot;
  const forecast = environment.weather.forecast ?? environment.forecast.forecast;
  const hasDetails = Boolean(
    overview.location
    || activeLocation
    || activeCities.length
    || travel
    || weather
    || forecast
  );

  if (!hasDetails) return <p>暂无地点、城市、出行或天气信息。</p>;

  return (
    <div className="life-environment-readonly" data-testid="life-environment-detail">
      <dl>
        <div><dt>当前地点</dt><dd>{overview.location?.name ?? activeLocation?.name ?? '暂无'}</dd></div>
        <div><dt>活动地点</dt><dd>{activeLocation?.name ?? '暂无'}</dd></div>
        <div><dt>活动城市</dt><dd>{activeCities.map((city) => city.name).join('、') || '暂无'}</dd></div>
      </dl>

      <section aria-labelledby="life-travel-title">
        <h4 id="life-travel-title">出行</h4>
        {travel ? (
          <dl>
            <div><dt>从</dt><dd>{locationName(travel.fromLocationId, environment)}</dd></div>
            <div><dt>到</dt><dd>{locationName(travel.toLocationId, environment)}</dd></div>
            <div><dt>方式</dt><dd>{TRAVEL_LABELS[travel.mode] ?? travel.mode}</dd></div>
            <div><dt>出发时间</dt><dd><time dateTime={travel.startedAt}>{travel.startedAt}</time></dd></div>
            <div><dt>预计到达</dt><dd><time dateTime={travel.expectedArriveAt}>{travel.expectedArriveAt}</time></dd></div>
          </dl>
        ) : <p>当前没有出行。</p>}
      </section>

      <section aria-labelledby="life-weather-title">
        <h4 id="life-weather-title">天气状态</h4>
        <dl>
          <div>
            <dt>当前天气</dt>
            <dd>
              {weather
                ? `${weatherConditionLabel(weather.condition)}${weather.temperatureC == null ? '' : ` · ${formatTemperature(weather.temperatureC)}`}`
                : overview.weather ?? '暂无天气状态'}
            </dd>
          </div>
          <div><dt>天气来源</dt><dd>{weather?.provider ?? environment.weather.provider.name ?? '暂无'}</dd></div>
        </dl>
      </section>

      <section aria-labelledby="life-forecast-title">
        <h4 id="life-forecast-title">天气预报</h4>
        {forecast ? (
          <>
            <ForecastDetails title="未来 12 小时" periods={forecast.next12h} />
            <ForecastDetails title="未来 3 天" periods={forecast.next3d} />
          </>
        ) : <p>暂无天气预报。</p>}
      </section>
    </div>
  );
}

function formatHistoryTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}

function HistoryDetails({ data }: { data: LifePanelData }) {
  const history = mergeLifeHistory(data.log, data.events, data.proactive);
  if (!history.length) return <p>暂无生活记录。</p>;
  return (
    <ul data-testid="life-history-list">
      {history.map((item) => (
        <li key={`${item.kind}-${item.id}`}>
          <span>{HISTORY_LABELS[item.kind]}</span>
          <strong>{item.title}</strong>
          <span>{item.detail}</span>
          <time dateTime={item.at}>{formatHistoryTime(item.at)}</time>
        </li>
      ))}
    </ul>
  );
}

export function LifeObservationDetails({ data, overview }: {
  data: LifePanelData;
  overview: AdminLifeOverview;
}) {
  const loadVitals = useCallback(() => adminApi.lifeVitals(), []);
  const loadEnvironment = useCallback(async (): Promise<EnvironmentData> => {
    const [locations, cities, travel, weather, forecast] = await Promise.all([
      adminApi.lifeLocations(),
      adminApi.lifeCities(),
      adminApi.lifeTravel(),
      adminApi.weatherStatus(),
      adminApi.weatherForecast()
    ]);
    return { locations, cities, travel, weather, forecast };
  }, []);
  const vitals = useLazyData(loadVitals);
  const environment = useLazyData(loadEnvironment);

  return (
    <div className="life-observation-details" data-testid="life-observation-details">
      <DisclosureSection
        id="life-details-vitals"
        title="身体与节律"
        summary="精力、饥饿与休息状态"
        onFirstOpen={vitals.load}
      >
        <RemoteState state={vitals.state} loadingText="正在读取身体与节律数据…" onRetry={vitals.load}>
          {(response) => <VitalsDetails vitals={response.vitals} />}
        </RemoteState>
      </DisclosureSection>

      <DisclosureSection
        id="life-details-environment"
        title="地点与天气"
        summary="当前地点、出行与天气"
        onFirstOpen={environment.load}
      >
        <RemoteState state={environment.state} loadingText="正在读取地点与天气…" onRetry={environment.load}>
          {(response) => <EnvironmentDetails environment={response} overview={overview} />}
        </RemoteState>
      </DisclosureSection>

      <DisclosureSection
        id="life-details-history"
        title="生活记录"
        summary="最近活动、事件与主动联系"
      >
        <HistoryDetails data={data} />
      </DisclosureSection>
    </div>
  );
}
