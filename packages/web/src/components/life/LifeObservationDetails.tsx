import { type ReactNode, useState } from 'react';
import type { AdminLifeOverview } from '../../lib/admin.js';
import type { LifePanelData } from '../../lib/features.js';

interface DisclosureSectionProps {
  id: string;
  title: string;
  summary: string;
  children: ReactNode;
}

export function DisclosureSection({ id, title, summary, children }: DisclosureSectionProps) {
  const [open, setOpen] = useState(false);
  const toggleId = `${id}-toggle`;

  return (
    <section className="life-detail-disclosure">
      <button
        id={toggleId}
        type="button"
        className="life-disclosure-toggle"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
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

function ThreadsDetails({ threads }: { threads: AdminLifeOverview['openThreads'] }) {
  if (!threads.length) return <p className="life-thread-empty">暂时没有持续发展的事。</p>;
  return (
    <ul className="life-thread-list" data-testid="life-thread-list">
      {threads.map((thread) => (
        <li className="life-thread-item" key={thread.id}>
          <div className="life-thread-copy">
            <strong>{thread.title}</strong>
            <small>正在发展</small>
          </div>
          <span className="life-thread-progress">{thread.progress}%</span>
        </li>
      ))}
    </ul>
  );
}

function formatHistoryTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}

function HistoryDetails({ data }: { data: LifePanelData }) {
  // This surface is for lived activity history only. Events stay available to
  // Life/Memory/Moments internally, and Moments have their own feed.
  const history = [...data.log].sort((left, right) => {
    const leftTime = Date.parse(left.ended_at);
    const rightTime = Date.parse(right.ended_at);
    const leftValid = Number.isFinite(leftTime);
    const rightValid = Number.isFinite(rightTime);
    if (leftValid && rightValid) return rightTime - leftTime;
    if (leftValid) return -1;
    if (rightValid) return 1;
    return 0;
  });

  if (!history.length) return <p className="life-thread-empty">暂无生活记录。</p>;

  return (
    <div className="life-history-scroll" data-testid="life-history-scroll">
      <ul data-testid="life-history-list">
        {history.map((item) => (
          <li key={item.id}>
            <span>活动</span>
            <strong>{item.activity}</strong>
            <span>{item.mood}</span>
            <time dateTime={item.ended_at}>{formatHistoryTime(item.ended_at)}</time>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function LifeObservationDetails({ data, overview }: {
  data: LifePanelData;
  overview: AdminLifeOverview;
}) {
  return (
    <div className="life-observation-details" data-testid="life-observation-details">
      <DisclosureSection
        id="life-details-threads"
        title="正在发展的事"
        summary="最近持续发展的事项"
      >
        <ThreadsDetails threads={overview.openThreads} />
      </DisclosureSection>

      <DisclosureSection
        id="life-details-history"
        title="生活记录"
        summary="最近活动"
      >
        <HistoryDetails data={data} />
      </DisclosureSection>
    </div>
  );
}
