import { Component, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent, type ReactNode } from 'react';
import { ADMIN_UNAUTHORIZED_EVENT, clearAdminToken, getAdminToken, setAdminToken } from '../lib/admin.js';
import { navigate as appNavigate, usePathname } from '../lib/navigation.js';
import { Icon, routeIcon } from './icons.js';
import { HerAvatar, MomentHero, MomentStrip, useMoment } from './Moment.js';
import { PAGES } from './pages/index.js';
import { ROUTES, canonicalPath, consolePath, routeFromPath, type ConsoleRoute } from './routes.js';
import { Button, Callout, ConsoleContext, Field, Input, type ConsoleContextValue } from './ui.js';
// 霞鹜文楷 (OFL): the console's soft, slightly handwritten face. Split by unicode range, so a page
// downloads only the glyphs it shows; bundled here so it never depends on a foreign font CDN.
import 'lxgw-wenkai-screen-webfont/lxgwwenkaigbscreen.css';
import './console.css';

interface Toast { id: number; message: string; tone?: 'ok' | 'bad' }

const TAB_SLUGS = ['', 'life', 'memory', 'chats'];
const TAB_LABELS: Record<string, string> = { chats: '聊天' };

const LEAVE_QUESTION = '这一页有没保存的修改，离开后会丢失。确定离开吗？';

export default function ConsoleApp() {
  const [token, setToken] = useState(() => getAdminToken());

  useEffect(() => {
    const onUnauthorized = () => setToken(null);
    window.addEventListener(ADMIN_UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(ADMIN_UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  if (!token) {
    return <div className="cs"><Lock onUnlock={(next) => { setAdminToken(next); setToken(next); }} /></div>;
  }
  return <div className="cs"><Shell onLock={() => { clearAdminToken(); setToken(null); }} /></div>;
}

function Lock({ onUnlock }: { onUnlock: (token: string) => void }) {
  const [value, setValue] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (value.trim()) onUnlock(value.trim());
  };
  return (
    <main className="cs-lock">
      <form onSubmit={submit}>
        <h1>SOOYA</h1>
        <p>输入管理令牌后进入。令牌只保存在这台设备上。</p>
        <Field label="管理令牌">
          <Input type="password" autoComplete="current-password" value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
        </Field>
        <div className="cs-actions"><Button type="submit" disabled={!value.trim()}>进入</Button></div>
      </form>
    </main>
  );
}

function Shell({ onLock }: { onLock: () => void }) {
  const pathname = usePathname();
  // Old addresses (retired admin sub-pages, /gallery, /console) move to their new page in place.
  useEffect(() => {
    const target = canonicalPath(pathname);
    if (target) appNavigate(target, { replace: true });
  }, [pathname]);
  const route = routeFromPath(pathname);
  const [navOpen, setNavOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const { data: moment, reload: refreshMoment } = useMoment();

  const setDirtyState = useCallback((value: boolean) => { dirtyRef.current = value; setDirty(value); }, []);

  const notify = useCallback((message: string, tone?: 'ok' | 'bad') => {
    const id = Date.now() + Math.random();
    setToasts((old) => [...old.slice(-2), { id, message, tone }]);
    window.setTimeout(() => setToasts((old) => old.filter((toast) => toast.id !== id)), tone === 'bad' ? 7000 : 3500);
  }, []);

  const go = useCallback((path: string) => {
    if (dirtyRef.current && !window.confirm(LEAVE_QUESTION)) return;
    setDirtyState(false);
    setNavOpen(false);
    appNavigate(path);
    window.scrollTo({ top: 0 });
  }, [setDirtyState]);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  useEffect(() => {
    if (!navOpen) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setNavOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navOpen]);

  useEffect(() => {
    document.title = route.slug ? `${route.label} · SOOYA` : 'SOOYA';
  }, [route]);

  const context = useMemo<ConsoleContextValue>(() => ({
    notify,
    markClean: () => setDirtyState(false),
    navigate: go,
    moment,
    refreshMoment,
    route
  }), [go, moment, notify, refreshMoment, route, setDirtyState]);

  const onLinkClick = (event: MouseEvent<HTMLAnchorElement>, target: ConsoleRoute) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    if (target.slug !== route.slug) go(consolePath(target.slug));
    else setNavOpen(false);
  };

  // Any edit inside the page marks it dirty, except search boxes, filters and uploads.
  // This listens in the bubble phase: marking dirty during capture re-rendered the shell before
  // the field's own onChange ran, and React restored the controlled value — the first keystroke vanished.
  const onInput = (event: FormEvent<HTMLElement>) => {
    if (dirtyRef.current) return;
    const target = event.target as HTMLElement;
    if (target instanceof HTMLInputElement && (target.type === 'file' || target.type === 'search')) return;
    if (target.closest('[data-no-dirty]')) return;
    setDirtyState(true);
  };

  const Page = PAGES[route.slug] ?? PAGES['']!;
  const groups: Array<[string, ConsoleRoute[], 'her' | 'system']> = [
    ['她', ROUTES.filter((r) => r.register === 'her'), 'her'],
    ['系统', ROUTES.filter((r) => r.register === 'system'), 'system']
  ];

  return (
    <ConsoleContext.Provider value={context}>
      <div className="cs-shell" data-nav-open={navOpen ? 'true' : undefined}>
        {navOpen && <button type="button" className="cs-scrim" aria-label="关闭栏目" onClick={() => setNavOpen(false)} />}
        <nav className="cs-nav" aria-label="管理栏目" id="cs-nav">
          <a className="cs-her" href={consolePath('')} onClick={(e) => onLinkClick(e, ROUTES[0]!)} aria-label="回到此刻">
            <HerAvatar persona={moment?.persona ?? null} />
            <span>
              <span className="cs-her-name">{moment?.persona?.name ?? 'SOOYA'}</span>
              <span className="cs-her-line">{moment?.persona?.tagline || '管理后台'}</span>
            </span>
          </a>
          {groups.map(([title, items, register]) => (
            <div className="cs-nav-group" data-register={register} key={title}>
              <h2>{title}</h2>
              {items.map((item) => (
                <a
                  key={item.slug}
                  className="cs-nav-link"
                  href={consolePath(item.slug)}
                  aria-current={item.slug === route.slug ? 'page' : undefined}
                  onClick={(e) => onLinkClick(e, item)}
                >
                  <Icon name={routeIcon(item.slug)} size={18} />
                  {item.label}
                </a>
              ))}
            </div>
          ))}
          <div className="cs-nav-foot">
            <button type="button" className="cs-nav-link" onClick={() => { if (!dirtyRef.current || window.confirm(LEAVE_QUESTION)) onLock(); }}>
              <Icon name="exit" size={18} />退出登录
            </button>
            <span className="cs-nav-product">SOOYA 管理后台</span>
          </div>
        </nav>
        <div className="cs-main">

          {route.slug === ''
            ? <MomentHero data={moment} />
            : <MomentStrip data={moment} onOpen={route.slug === 'life' ? undefined : () => go(consolePath('life'))} />}
          <main onInput={onInput}>
            <PageBoundary key={route.slug} label={route.label}>
              <Page />
            </PageBoundary>
          </main>
        </div>
      </div>
      {/* phones: the pages used most, one tap away; everything else behind 更多 */}
      <nav className="cs-tabbar" aria-label="常用栏目">
        {TAB_SLUGS.map((slug) => {
          const item = ROUTES.find((r) => r.slug === slug)!;
          return (
            <a key={slug} className="cs-tab-item" href={consolePath(slug)} aria-current={route.slug === slug ? 'page' : undefined} onClick={(e) => onLinkClick(e, item)}>
              <Icon name={routeIcon(slug)} size={22} />
              <span>{TAB_LABELS[slug] ?? item.label}</span>
            </a>
          );
        })}
        <button type="button" className="cs-tab-item" aria-current={TAB_SLUGS.includes(route.slug) ? undefined : 'page'}
          aria-expanded={navOpen} aria-controls="cs-nav" onClick={() => setNavOpen(true)}>
          <Icon name="menu" size={22} />
          <span>{TAB_SLUGS.includes(route.slug) ? '更多' : route.label}</span>
        </button>
      </nav>
      {dirty && <div className="cs-dirty-pill" role="status">这一页有没保存的修改</div>}
      <div className="cs-toasts" aria-live="polite">
        {toasts.map((toast) => <div className="cs-toast" data-tone={toast.tone} key={toast.id}>{toast.message}</div>)}
      </div>
    </ConsoleContext.Provider>
  );
}

/** One page failing must not blank the whole console: show what broke and a way back. */
class PageBoundary extends Component<{ label: string; children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <section className="cs-page">
        <Callout tone="bad">
          「{this.props.label}」这一页出错了：{this.state.error.message || '未知错误'}。其他页面不受影响。{' '}
          <Button kind="text" size="sm" onClick={() => this.setState({ error: null })}>重新加载这一页</Button>
        </Callout>
      </section>
    );
  }
}