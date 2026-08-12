import type { ConnectionState, LifeState, PersonaInfo, WorldPresence } from '../lib/types.js';
import { AppLink } from './AppLink.js';
import { HeaderWorldPresence } from './HeaderWorldPresence.js';
import { NotificationBridge } from './NotificationBridge.js';
import './ChatHeader.css';

export interface ChatHeaderProps {
  persona: PersonaInfo | null;
  connection: ConnectionState;
  statusLabel: string;
  life: LifeState | null;
  presence: WorldPresence | null;
  onSearch: () => void;
}

export function ChatHeader({ persona, connection, statusLabel, life, presence, onSearch }: ChatHeaderProps) {
  return (
    <header className="topbar chat-topbar">
      <div className="topbar-identity">
        <img className="topbar-avatar" src={persona?.avatar ?? '/avatars/sooya.svg'} alt="" />
        <div className="topbar-text">
          <span className="topbar-name">{persona?.name ?? 'SOOYA'}</span>
          <span className={`topbar-status ${connection}`} data-testid="connection-status"><span className="status-dot" />{statusLabel}</span>
          {connection === 'online' && life && <span className="topbar-life" data-testid="life-activity" title={`心情${life.mood}`}>{life.activity}</span>}
        </div>
      </div>
      <HeaderWorldPresence presence={presence} />
      <div className="topbar-actions">
        <NotificationBridge />
        <AppLink className="topbar-admin-entry topbar-moments-entry" href="/moments" aria-label="打开朋友圈" title="朋友圈" data-testid="moments-entry">
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="4" y="5" width="16" height="14" rx="3" /><circle cx="9" cy="10" r="1.5" /><path d="m6.5 17 4.2-4 2.8 2.4 2.2-2 2.3 2.1" /></svg>
        </AppLink>
        <button type="button" className="history-tool-button" aria-label="搜索和日期跳转" onClick={onSearch} data-testid="history-tools">
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" data-testid="history-search-icon"><circle cx="10.8" cy="10.8" r="6.2" /><path d="m15.5 15.5 5 5" /></svg>
        </button>
        <AppLink className="topbar-admin-entry" href="/admin" aria-label="进入管理中心" data-testid="admin-entry">
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" data-testid="admin-entry-icon" data-icon-style="six-tooth"><circle cx="12" cy="12" r="3.35" /><path d="M12 2.8v2.1" /><path d="m19.97 7.4-1.82 1.05" /><path d="m19.97 16.6-1.82-1.05" /><path d="M12 21.2v-2.1" /><path d="m4.03 16.6 1.82-1.05" /><path d="m4.03 7.4 1.82 1.05" /></svg>
        </AppLink>
      </div>
    </header>
  );
}
