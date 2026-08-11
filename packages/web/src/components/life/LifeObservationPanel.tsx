import { useCallback, useEffect, useRef, useState } from 'react';
import {
  adminApi,
  type AdminLifeLocation,
  type AdminLifeOverview,
  type AdminLifeVitals,
  type TravelState,
  type WeatherStatus
} from '../../lib/admin.js';
import { featureApi, type LifePanelData } from '../../lib/features.js';
import { lifeKindLabel, lifePlanStatusText, previewPlans } from '../../lib/lifeObservation.js';
import { formatTemperature, formatVital } from '../../lib/numberDisplay.js';
import { herClock, reachReasonText } from '../../lib/lifeView.js';
import { weatherConditionLabel } from '../../lib/worldDisplay.js';
import { LifeContactBoundaryForm } from './LifeContactBoundaryForm.js';
import { LifeObservationDetails } from './LifeObservationDetails.js';

interface LifeObservationPanelProps {
  onNotice: (message: string) => void;
}

type VitalTone = 'muted' | 'good' | 'warn' | 'accent';

type VitalDisplay = {
  label: string;
  tone: VitalTone;
};

type HeroEnvironment = {
  locations: { locations: AdminLifeLocation[]; current: AdminLifeLocation | null } | null;
  travel: { travel: TravelState | null } | null;
  weather: WeatherStatus | null;
};

const EMPTY_HERO_ENVIRONMENT: HeroEnvironment = {
  locations: null,
  travel: null,
  weather: null
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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function updatedText(updatedAt: string, tzOffsetMinutes: number): string {
  if (Date.now() - Date.parse(updatedAt) < 60_000) return '刚刚更新';
  return `更新于 ${herClock(updatedAt, tzOffsetMinutes)}`;
}

function genericLevel(value: number): string {
  if (value <= 15) return '很低';
  if (value <= 35) return '偏低';
  if (value <= 65) return '中等';
  if (value <= 85) return '偏高';
  return '很高';
}

function vitalDisplay(key: keyof AdminLifeVitals, value: number): VitalDisplay {
  if (key === 'sleep_debt') {
    if (value <= 0.05) return { label: '无欠债', tone: 'good' };
    if (value <= 1) return { label: '很少', tone: 'muted' };
    if (value <= 2.5) return { label: '轻微', tone: 'warn' };
    return { label: '偏高', tone: 'warn' };
  }

  if (key === 'stress') {
    if (value <= 15) return { label: '很轻松', tone: 'good' };
    if (value <= 35) return { label: '偏低', tone: 'good' };
    if (value <= 65) return { label: '中等', tone: 'muted' };
    return { label: value <= 85 ? '偏高' : '很高', tone: 'warn' };
  }

  const label = value >= 98 && (key === 'comfort' || key === 'focus') ? '极佳' : genericLevel(value);
  if ((key === 'comfort' || key === 'focus') && value >= 86) return { label, tone: 'good' };
  if (key === 'energy' && value <= 35) return { label, tone: 'warn' };
  if ((key === 'hunger' || key === 'social_need' || key === 'loneliness') && value >= 66) return { label, tone: 'warn' };
  if (key === 'curiosity' && value >= 86) return { label, tone: 'accent' };
  return { label, tone: 'muted' };
}

function heroPlace(environment: HeroEnvironment, overview: AdminLifeOverview): string {
  const current = environment.locations?.current;
  const city = current?.city?.trim() || null;
  const place = current?.name ?? overview.location?.name ?? null;
  return [city, place].filter((value): value is string => Boolean(value)).join(' · ') || '暂无';
}

function heroWeather(environment: HeroEnvironment, overview: AdminLifeOverview): string {
  const snapshot = environment.weather?.lastSnapshot;
  const condition = snapshot?.condition ?? overview.weather;
  const label = condition ? weatherConditionLabel(condition) : null;
  const temperature = snapshot?.temperatureC == null ? null : formatTemperature(snapshot.temperatureC);
  return [label, temperature].filter((value): value is string => Boolean(value)).join(' · ') || '暂无';
}

function heroTravel(environment: HeroEnvironment): string {
  const travel = environment.travel?.travel;
  if (!travel) return '没有出行';
  const destination = environment.locations?.locations.find((location) => location.id === travel.toLocationId)?.name;
  return destination ? `去${destination}路上` : '出行中';
}

function VitalsGrid({ vitals }: { vitals: AdminLifeVitals | null }) {
  return (
    <section className="life-vitals-card" data-testid="life-vitals-card">
      <div className="life-card-heading">
        <h3>身体与节律</h3>
        <small>实时状态</small>
      </div>
      {vitals ? (
        <div className="life-vitals-grid" data-testid="life-vitals-grid">
          {VITAL_FIELDS.map(({ key, label }) => {
            const value = vitals[key];
            const display = vitalDisplay(key, value);
            return (
              <div className="life-vital-item" data-vital={key} key={key}>
                <div className="life-vital-main">
                  <span className="life-vital-name">{label}</span>
                  <strong className="life-vital-value">{formatVital(key, value)}</strong>
                </div>
                <span className="life-vital-level" data-tone={display.tone}>{display.label}</span>
              </div>
            );
          })}
        </div>
      ) : <p className="life-vitals-empty">暂无身体与节律数据。</p>}
    </section>
  );
}

export function LifeObservationPanel({ onNotice }: LifeObservationPanelProps) {
  const [data, setData] = useState<LifePanelData | null>(null);
  const [overview, setOverview] = useState<AdminLifeOverview | null>(null);
  const [heroEnvironment, setHeroEnvironment] = useState<HeroEnvironment>(EMPTY_HERO_ENVIRONMENT);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const lifecycleGenerationRef = useRef(0);
  const requestGenerationRef = useRef(0);

  const load = useCallback(async (lifecycleGeneration: number) => {
    const requestGeneration = ++requestGenerationRef.current;
    try {
      const [nextData, nextOverview, nextLocations, nextTravel, nextWeather] = await Promise.all([
        featureApi.life(),
        adminApi.lifeOverview(),
        adminApi.lifeLocations().catch(() => null),
        adminApi.lifeTravel().catch(() => null),
        adminApi.weatherStatus().catch(() => null)
      ]);
      if (
        lifecycleGenerationRef.current !== lifecycleGeneration
        || requestGenerationRef.current !== requestGeneration
      ) return;
      setData(nextData);
      setOverview(nextOverview);
      setHeroEnvironment({ locations: nextLocations, travel: nextTravel, weather: nextWeather });
      setUpdatedAt(new Date().toISOString());
      setError(null);
    } catch (loadError) {
      if (
        lifecycleGenerationRef.current === lifecycleGeneration
        && requestGenerationRef.current === requestGeneration
      ) setError(errorText(loadError));
    }
  }, []);

  useEffect(() => {
    const lifecycleGeneration = ++lifecycleGenerationRef.current;
    void load(lifecycleGeneration);
    const interval = window.setInterval(() => { void load(lifecycleGeneration); }, 30_000);
    return () => {
      window.clearInterval(interval);
      if (lifecycleGenerationRef.current === lifecycleGeneration) {
        lifecycleGenerationRef.current += 1;
        requestGenerationRef.current += 1;
      }
    };
  }, [load]);

  const retry = () => { void load(lifecycleGenerationRef.current); };

  if (!data || !overview) {
    return (
      <section className="life-observation" data-testid="life-observation">
        {error ? (
          <div role="alert">
            <p>{error}</p>
            <button type="button" onClick={retry}>重新读取</button>
          </div>
        ) : (
          <div className="admin-overview-state" aria-label="正在读取她的生活">正在读取……</div>
        )}
      </section>
    );
  }

  const timezone = data.settings.tzOffsetMinutes;
  const plans = previewPlans(data.plans);
  const currentTime = herClock(new Date().toISOString(), timezone);

  return (
    <section className="life-observation" data-testid="life-observation">
      {error && (
        <div role="alert">
          <span>
            更新失败，正在显示上次成功读取的状态。
            {updatedAt && `上次成功更新于 ${herClock(updatedAt, timezone)}。`}
          </span>
          <button type="button" onClick={retry}>重试</button>
        </div>
      )}

      <section className="life-hero-card" data-testid="life-hero">
        <div className="life-hero-head">
          <div className="life-hero-copy">
            <span className="life-hero-kicker">SOOYA 当前状态</span>
            <strong className="life-hero-activity">{data.snapshot.activity}</strong>
            <span className="life-hero-meta">{lifeKindLabel(data.snapshot.kind)} · 心情{data.snapshot.mood}</span>
          </div>
          <span className="life-hero-clock">{currentTime}{updatedAt ? ` · ${updatedText(updatedAt, timezone)}` : ''}</span>
        </div>
        <div className="life-hero-facts">
          <div className="life-hero-fact">
            <span>当前地点</span>
            <strong>{heroPlace(heroEnvironment, overview)}</strong>
          </div>
          <div className="life-hero-fact">
            <span>当前天气</span>
            <strong>{heroWeather(heroEnvironment, overview)}</strong>
          </div>
          <div className="life-hero-fact">
            <span>出行状态</span>
            <strong>{heroTravel(heroEnvironment)}</strong>
          </div>
          <div className="life-hero-fact">
            <span>当前活动</span>
            <strong>{data.snapshot.activity}</strong>
          </div>
        </div>
        <p className="life-hero-note">{reachReasonText(data)}</p>
      </section>

      <VitalsGrid vitals={overview.vitals} />

      <section className="life-plan-card" data-testid="life-preview">
        <div className="life-card-heading">
          <h3>可能会做</h3>
          <small>由她自行决定</small>
        </div>
        {plans.length ? (
          <ul className="life-plan-list">
            {plans.map((plan) => (
              <li className="life-plan-item" key={plan.id}>
                <div className="life-plan-copy">
                  <strong>{plan.title}</strong>
                  <small>{lifeKindLabel(plan.kind)} · {lifePlanStatusText(plan.status)}</small>
                </div>
                {plan.planned_start && <time className="life-plan-time" dateTime={plan.planned_start}>{herClock(plan.planned_start, timezone)}</time>}
              </li>
            ))}
          </ul>
        ) : <p className="life-plan-empty">她还没有决定接下来做什么。</p>}
      </section>

      <div className="life-secondary-card" data-testid="life-secondary-card">
        <LifeObservationDetails data={data} overview={overview} />
        <LifeContactBoundaryForm initial={data.settings} onNotice={onNotice} />
      </div>
    </section>
  );
}
