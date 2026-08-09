import { useCallback, useEffect, useRef, useState } from 'react';
import { adminApi, type AdminLifeOverview } from '../../lib/admin.js';
import { featureApi, type LifePanelData } from '../../lib/features.js';
import { lifeKindLabel, lifePlanStatusText, previewPlans } from '../../lib/lifeObservation.js';
import { herClock, reachReasonText, slotProgress } from '../../lib/lifeView.js';
import { LifeObservationDetails } from './LifeObservationDetails.js';

interface LifeObservationPanelProps {
  onNotice: (message: string) => void;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function updatedText(updatedAt: string, tzOffsetMinutes: number): string {
  if (Date.now() - Date.parse(updatedAt) < 60_000) return '刚刚更新';
  return `更新于 ${herClock(updatedAt, tzOffsetMinutes)}`;
}

export function LifeObservationPanel({ onNotice: _onNotice }: LifeObservationPanelProps) {
  const [data, setData] = useState<LifePanelData | null>(null);
  const [overview, setOverview] = useState<AdminLifeOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const lifecycleGenerationRef = useRef(0);
  const requestGenerationRef = useRef(0);

  const load = useCallback(async (lifecycleGeneration: number) => {
    const requestGeneration = ++requestGenerationRef.current;
    try {
      const [nextData, nextOverview] = await Promise.all([
        featureApi.life(),
        adminApi.lifeOverview()
      ]);
      if (
        lifecycleGenerationRef.current !== lifecycleGeneration
        || requestGenerationRef.current !== requestGeneration
      ) return;
      setData(nextData);
      setOverview(nextOverview);
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
        <h2>她的生活</h2>
        <p>状态会随时间自行变化</p>
        {error ? (
          <div role="alert">
            <p>{error}</p>
            <button type="button" onClick={retry}>重新读取</button>
          </div>
        ) : (
          <div aria-label="正在读取她的生活">正在读取……</div>
        )}
      </section>
    );
  }

  const timezone = data.settings.tzOffsetMinutes;
  const progress = slotProgress(data.snapshot);
  const plans = previewPlans(data.plans);

  return (
    <section className="life-observation" data-testid="life-observation">
      <h2>她的生活</h2>
      <p>状态会随时间自行变化</p>
      {updatedAt && <small>{updatedText(updatedAt, timezone)}</small>}
      {error && (
        <div role="alert">
          <span>
            更新失败，正在显示上次成功读取的状态。
            {updatedAt && `上次成功更新于 ${herClock(updatedAt, timezone)}。`}
          </span>
          <button type="button" onClick={retry}>重试</button>
        </div>
      )}

      <div className="life-now-summary" data-testid="life-now-summary">
        <h3>此刻 · {herClock(new Date().toISOString(), timezone)}</h3>
        <p>{data.snapshot.activity}</p>
        <p>{lifeKindLabel(data.snapshot.kind)} · 心情{data.snapshot.mood}</p>
        <p>已经 {progress.intoIt}，还有 {progress.left}</p>
        <progress
          value={progress.percent}
          max={100}
          role="progressbar"
          aria-label={`当前活动进度 ${progress.percent}%`}
        >{progress.percent}%</progress>
        <p>{reachReasonText(data)}</p>
        <p>今日已主动联系 {data.reachOut.sharedLastDay} 次（每日上限 {data.settings.maxReachOutsPerDay} 次）</p>
      </div>

      <div className="life-preview" data-testid="life-preview">
        <h3>今天可能会做</h3>
        <p>由她自行决定</p>
        {plans.length ? (
          <ul>
            {plans.map((plan) => (
              <li key={plan.id}>
                <span>{plan.title}</span>
                <small>{lifeKindLabel(plan.kind)} · {lifePlanStatusText(plan.status)}</small>
              </li>
            ))}
          </ul>
        ) : <p>她还没有决定接下来做什么。</p>}
      </div>

      <div className="life-threads-preview" data-testid="life-threads-preview">
        <h3>正在发展的事</h3>
        {overview.openThreads.length ? (
          <ul>
            {overview.openThreads.map((thread) => (
              <li key={thread.id}><span>{thread.title}</span><small>{thread.progress}%</small></li>
            ))}
          </ul>
        ) : <p>暂时没有持续发展的事。</p>}
      </div>
      <LifeObservationDetails data={data} overview={overview} />
    </section>
  );
}
