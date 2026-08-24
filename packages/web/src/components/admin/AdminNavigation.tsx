import { Fragment } from 'react';
import { NAV_GROUPS, TABS, type IconName, type Tab } from './admin-types.js';

export function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, JSX.Element> = {
    mcp: <><circle cx="7" cy="12" r="3" /><circle cx="17" cy="7" r="3" /><circle cx="17" cy="17" r="3" /><path d="m9.5 10.5 5-2M9.5 13.5l5 2" /></>,
    overview: <><rect x="3" y="3" width="7" height="7" rx="2" /><rect x="14" y="3" width="7" height="7" rx="2" /><rect x="3" y="14" width="7" height="7" rx="2" /><rect x="14" y="14" width="7" height="7" rx="2" /></>,
    persona: <><circle cx="12" cy="8" r="4" /><path d="M4.8 21a7.2 7.2 0 0 1 14.4 0" /></>,
    models: <><rect x="4" y="4" width="16" height="16" rx="4" /><path d="M9 9h6v6H9zM9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3" /></>,
    content: <><path d="M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" /><path d="m7 15 3-3 2.5 2.5L15 12l3 3M8 9h.01" /></>,
    operations: <><circle cx="12" cy="12" r="3" /><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4" /></>,
    message: <><path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-5 4v-4a2 2 0 0 1-1-1.73V7a2 2 0 0 1 2-2Z" /><path d="M8 9h8M8 13h5" /></>,
    cpu: <><rect x="6" y="6" width="12" height="12" rx="3" /><path d="M9 9h6v6H9zM9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" /></>,
    storage: <><ellipse cx="12" cy="5.5" rx="8" ry="3.5" /><path d="M4 5.5v6c0 1.9 3.6 3.5 8 3.5s8-1.6 8-3.5v-6M4 11.5v6c0 1.9 3.6 3.5 8 3.5s8-1.6 8-3.5v-6" /></>,
    backup: <><path d="M7 7h10a4 4 0 0 1 4 4v6a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4v-6a4 4 0 0 1 4-4Z" /><path d="M8 7V4h8v3M9 14h6M12 11v6" /></>,
    lock: <><rect x="5" y="10" width="14" height="11" rx="3" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" /></>
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}

export function TabButtons({ tab, setTab, mobile }: { tab: Tab; setTab: (tab: Tab) => void; mobile: boolean }) {
  return (
    <nav className={mobile ? 'admin-mobile-tabs' : 'admin-side-nav'} aria-label="管理面板导航">
      {mobile
        ? TABS.map((item) => (
          <button key={item.id} type="button" data-testid={`admin-tab-${item.id}`} aria-current={tab === item.id ? 'page' : undefined} className={tab === item.id ? 'active' : ''} onClick={() => setTab(item.id)}>
            {item.label}
          </button>
        ))
        : NAV_GROUPS.map((group) => (
          <Fragment key={group}>
            <p className="admin-nav-group">{group}</p>
            {TABS.filter((item) => item.group === group).map((item) => (
              <button key={item.id} type="button" data-testid={`admin-tab-${item.id}`} aria-current={tab === item.id ? 'page' : undefined} className={tab === item.id ? 'active' : ''} onClick={() => setTab(item.id)}>
                <span className="admin-nav-icon"><Icon name={item.icon} /></span>
                <span className="admin-nav-copy"><strong>{item.label}</strong><small>{item.description}</small></span>
              </button>
            ))}
          </Fragment>
        ))}
    </nav>
  );
}
