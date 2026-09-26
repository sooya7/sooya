import { useState } from 'react';
import { Page, Tabs } from '../ui.js';
import { Album } from './Media/Album.js';
import { MediaList } from './Media/MediaList.js';
import { Stickers } from './Media/Stickers.js';
import './Media.css';

type Tab = 'album' | 'all' | 'stickers' | 'trash';
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'album', label: '相册' },
  { id: 'all', label: '全部媒体' },
  { id: 'stickers', label: '表情包' },
  { id: 'trash', label: '回收站' }
];

function tabFromHash(): Tab {
  const hash = typeof window === 'undefined' ? '' : window.location.hash.replace(/^#/, '');
  return TABS.some((tab) => tab.id === hash) ? (hash as Tab) : 'album';
}

export default function Media() {
  const [tab, setTab] = useState<Tab>(tabFromHash);
  const change = (next: Tab) => {
    setTab(next);
    // Keep the tab in the address so a refresh or a shared link lands on it.
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}${next === 'album' ? '' : `#${next}`}`);
  };

  return (
    <Page title="相册与表情" register="her" intro="她发过、画过的图和语音，以及她用来表达情绪的表情包。">
      <div data-no-dirty><Tabs label="相册与表情" tabs={TABS} value={tab} onChange={change} /></div>
      <div className="media-page">
        {tab === 'album' && <Album onShowAll={() => change('all')} />}
        {tab === 'all' && <MediaList key="all" mode="active" />}
        {tab === 'stickers' && <Stickers />}
        {tab === 'trash' && <MediaList key="trash" mode="trashed" onEmptyAction={() => change('album')} />}
      </div>
    </Page>
  );
}
