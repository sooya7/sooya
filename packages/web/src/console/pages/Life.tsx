import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { featureApi } from '../../lib/features.js';
import { Loadable, Page, Tabs, useConsole, useLoad } from '../ui.js';
import { LifeContext, type LifeContextValue } from './life/shared.js';
import { TodayTab } from './life/Today.js';
import { PlacesTab } from './life/Places.js';
import { ReachTab } from './life/Reach.js';
import { RecordsTab } from './life/Records.js';
import './life.css';

type TabId = 'today' | 'places' | 'reach' | 'records';

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'today', label: '今天' },
  { id: 'places', label: '地点与天气' },
  { id: 'reach', label: '主动找你' },
  { id: 'records', label: '生活记录' }
];

function initialTab(): TabId {
  const hash = typeof window === 'undefined' ? '' : window.location.hash.replace('#', '');
  return TABS.some((tab) => tab.id === hash) ? (hash as TabId) : 'today';
}

export default function Life() {
  const { markClean } = useConsole();
  const [tab, setTab] = useState<TabId>(initialTab);
  // Tabs stay mounted after the first visit so a half-filled form survives switching.
  const [visited, setVisited] = useState<Set<TabId>>(() => new Set([initialTab()]));
  const [version, setVersion] = useState(0);
  const [pulse, setPulse] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => setPulse((n) => n + 1), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const panel = useLoad(() => featureApi.life(), [version, pulse]);

  const dirty = useRef(new Set<string>());
  const touch = useCallback((key: string) => { dirty.current.add(key); }, []);
  const settle = useCallback((key: string) => {
    dirty.current.delete(key);
    if (dirty.current.size === 0) markClean();
  }, [markClean]);
  const refresh = useCallback(() => setVersion((n) => n + 1), []);

  const tz = panel.data?.settings.tzOffsetMinutes ?? 480;
  const ctx = useMemo<LifeContextValue>(() => ({ version, pulse, refresh, tz, touch, settle }), [version, pulse, refresh, tz, touch, settle]);

  const show = useCallback((id: TabId) => {
    setTab(id);
    setVisited((old) => (old.has(id) ? old : new Set(old).add(id)));
  }, []);
  const choose = (id: TabId) => {
    show(id);
    window.history.replaceState(null, '', `#${id}`);
  };

  // A link or the back button that only changes the hash still switches the tab.
  useEffect(() => {
    const onHash = () => show(initialTab());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [show]);

  return (
    <LifeContext.Provider value={ctx}>
      <Page
        title="生活"
        register="her"
        intro="她每天怎么过：在做什么、身体怎么样、惦记着什么、人在哪、会不会主动来找你。这里看到的都是生活模拟的真实状态，可以直接调整。"
      >
        <Tabs tabs={TABS} value={tab} onChange={choose} label="生活的几个方面" />
        {visited.has('today') && (
          <div hidden={tab !== 'today'}>
            <Loadable state={panel} label="生活数据">{(data) => <TodayTab panel={data} />}</Loadable>
          </div>
        )}
        {visited.has('places') && <div hidden={tab !== 'places'}><PlacesTab /></div>}
        {visited.has('reach') && (
          <div hidden={tab !== 'reach'}>
            <Loadable state={panel} label="生活数据">{(data) => <ReachTab panel={data} />}</Loadable>
          </div>
        )}
        {visited.has('records') && (
          <div hidden={tab !== 'records'}>
            <Loadable state={panel} label="生活数据">{(data) => <RecordsTab panel={data} />}</Loadable>
          </div>
        )}
      </Page>
    </LifeContext.Provider>
  );
}
