import { useState } from 'react';
import { adminApi } from '../../../lib/admin.js';
import type { LifePanelData } from '../../../lib/features.js';
import { lifeKindLabel } from '../../../lib/lifeObservation.js';
import { lifeEventText, sortedLog } from '../../../lib/lifeView.js';
import { Button, Empty, Loadable, Section, Select, Tag, useLoad } from '../../ui.js';
import { herRange, herWhen, useLife } from './shared.js';

/** The events route returns raw rows (snake_case); the old wrapper's type says camelCase. Accept both. */
interface EventView {
  id: string;
  type: string;
  description: string;
  at: string;
  kind: string | null;
  moodBefore: string | null;
  moodAfter: string | null;
  shareable: boolean;
  sharedAt: string | null;
}

function normalizeEvent(raw: Record<string, unknown>): EventView {
  const str = (...keys: string[]) => {
    for (const key of keys) if (typeof raw[key] === 'string' && raw[key]) return raw[key] as string;
    return null;
  };
  return {
    id: String(raw.id),
    type: str('event_type', 'eventType') ?? 'unknown',
    description: str('description') ?? '',
    at: str('happened_at', 'happenedAt', 'created_at') ?? '',
    kind: str('kind'),
    moodBefore: str('mood_before', 'moodBefore'),
    moodAfter: str('mood_after', 'moodAfter'),
    shareable: Boolean(raw.shareable),
    sharedAt: str('shared_at', 'sharedAt')
  };
}

export function RecordsTab({ panel }: { panel: LifePanelData }) {
  return (
    <>
      <EventsSection />
      <LogSection panel={panel} />
    </>
  );
}

function EventsSection() {
  const { version, tz } = useLife();
  const [limit, setLimit] = useState('50');
  const [type, setType] = useState('');
  const state = useLoad(async () => {
    const result = await adminApi.lifeEvents(Number(limit));
    return (result.events as unknown as Array<Record<string, unknown>>).map(normalizeEvent);
  }, [version, limit]);

  return (
    <Section title="生活事件" desc="她生活里发生过的小事：换了地方、做完一件事、开始下雨、遇到的小插曲。聊天时她可能会提起其中值得说的。">
      <div className="cs-actions" data-no-dirty>
        <label className="life-inline-field">
          <span className="cs-muted">显示最近</span>
          <Select value={limit} onChange={(e) => setLimit(e.target.value)} options={[
            { value: '50', label: '50 条' }, { value: '100', label: '100 条' }, { value: '200', label: '200 条' }
          ]} />
        </label>
        {state.data && state.data.length > 0 && (
          <label className="life-inline-field">
            <span className="cs-muted">只看</span>
            <Select value={type} onChange={(e) => setType(e.target.value)} options={[
              { value: '', label: '全部' },
              ...[...new Set(state.data.map((e) => e.type))].map((t) => ({ value: t, label: lifeEventText(t) }))
            ]} />
          </label>
        )}
        <Button kind="text" size="sm" busy={state.loading && !!state.data} onClick={() => void state.reload()}>刷新</Button>
      </div>
      <Loadable state={state} label="生活事件">
        {(events) => {
          const rows = type ? events.filter((e) => e.type === type) : events;
          if (!events.length) return <Empty>还没有生活事件。生活模拟推进、换地方或者天气变化的时候会记下来。</Empty>;
          if (!rows.length) return <p className="cs-muted">这一类最近没有。</p>;
          return (
            <div className="cs-list">
              {rows.map((event) => (
                <div className="cs-list-item" key={event.id}>
                  <span className="life-event-text">{event.description || lifeEventText(event.type)}</span>
                  <span className="cs-list-side">
                    {event.sharedAt ? <Tag tone="ok">分享过</Tag> : event.shareable ? <Tag>值得分享</Tag> : null}
                  </span>
                  <span className="cs-list-meta">
                    {[
                      herWhen(event.at, tz),
                      lifeEventText(event.type),
                      event.kind ? lifeKindLabel(event.kind) : null,
                      event.moodBefore && event.moodAfter && event.moodBefore !== event.moodAfter ? `心情从${event.moodBefore}变成${event.moodAfter}` : null
                    ].filter(Boolean).join('，')}
                  </span>
                </div>
              ))}
            </div>
          );
        }}
      </Loadable>
    </Section>
  );
}

function LogSection({ panel }: { panel: LifePanelData }) {
  const { tz } = useLife();
  const rows = sortedLog(panel.log);
  return (
    <Section title="做过的事" desc="最近 24 段已经结束的活动，最新的在上面。">
      {rows.length ? (
        <div className="cs-list">
          {rows.map((row) => (
            <div className="cs-list-item" key={row.id}>
              <span className="cs-list-title">{row.activity}</span>
              <span className="cs-list-side">{row.shared ? <Tag tone="ok">分享过</Tag> : null}</span>
              <span className="cs-list-meta">
                {[herRange(row.started_at, row.ended_at, tz), lifeKindLabel(row.kind), row.mood ? `心情${row.mood}` : null].filter(Boolean).join('，')}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <Empty>还没有做完的活动。她每做完一件事，这里就会多一条。</Empty>
      )}
    </Section>
  );
}
