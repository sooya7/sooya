import type { ReactNode, MouseEvent as ReactMouseEvent } from 'react';
import { AppLink } from '../AppLink.js';
import { Icon, TabButtons } from './AdminNavigation.js';
import { TABS, type Tab } from './admin-types.js';

export interface AdminShellProps {
  tab: Tab;
  page: { title: string; description: string };
  isMobile: boolean;
  dirty: boolean;
  notice: string | null;
  content: ReactNode;
  onTabChange: (tab: Tab) => void;
  onReturn: (event: ReactMouseEvent<HTMLAnchorElement>) => void;
  onLogout: () => void;
  onInputCapture: (event: React.FormEvent<HTMLElement>) => void;
  onSubmitCapture: () => void;
}

export function AdminShell({
  tab,
  page,
  isMobile,
  dirty,
  notice,
  content,
  onTabChange,
  onReturn,
  onLogout,
  onInputCapture,
  onSubmitCapture
}: AdminShellProps) {
  return (
    <main className="admin-page admin-v2" data-testid="admin-dashboard" data-dirty={dirty || undefined} onInputCapture={onInputCapture} onSubmitCapture={onSubmitCapture}>
      <div className="admin-shell">
        {!isMobile && <aside className="admin-sidebar">
          <div className="admin-brand"><span className="admin-brand-mark">S</span><span className="admin-brand-copy"><strong>SOOYA</strong><small>管理中心</small></span></div>
          <TabButtons tab={tab} setTab={onTabChange} mobile={false} />
          <div className="admin-sidebar-footer">
            <AppLink className="admin-side-action" href="/" data-testid="admin-return-chat" onClick={onReturn}>返回对话</AppLink>
            <button type="button" className="admin-side-action subtle" onClick={onLogout}>退出管理</button>
          </div>
        </aside>}

        {isMobile && <header className="admin-mobile-header"><div className="admin-mobile-brand"><span className="admin-mobile-icon"><Icon name={TABS.find((item) => item.id === tab)?.icon ?? 'overview'} /></span><div><strong>SOOYA 管理中心</strong><small>{page.title}</small></div></div><AppLink className="admin-return" href="/" data-testid="admin-return-chat" onClick={onReturn}>返回对话</AppLink></header>}

        <section className="admin-main">
          <div className="admin-main-inner">
            {isMobile && <TabButtons tab={tab} setTab={onTabChange} mobile />}
            {!isMobile && <header className="admin-content-header"><div className="admin-title-wrap"><span className="admin-eyebrow">SOOYA ADMIN</span><h1>{page.title}</h1><p>{page.description}</p></div></header>}
            <div className="admin-mobile-content">
              {isMobile && <div className="admin-mobile-title"><h1>{page.title}</h1><p>{page.description}</p></div>}
              {notice ? <div className="admin-inline-error" role="status">{notice}</div> : null}
              {content}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
