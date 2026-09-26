import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes
} from 'react';
import { ApiError } from '../lib/api.js';
import { adminFailureKind } from '../lib/admin.js';
import type { MomentData } from './Moment.js';
import { ROUTES, type ConsoleRoute } from './routes.js';
import { Icon, routeIcon, sectionIcon } from './icons.js';

/* ------------------------------------------------------------ context */

export type Tone = 'ok' | 'warn' | 'bad' | 'off';

export interface ConsoleContextValue {
  /** Short confirmation or error line shown at the bottom of the screen. */
  notify: (message: string, tone?: 'ok' | 'bad') => void;
  /** Call after a successful save so leaving the page no longer warns. */
  markClean: () => void;
  navigate: (path: string) => void;
  /** Her current state, shared with the strip so pages do not refetch it. */
  moment: MomentData | null;
  /** Re-read her state now (after moving her, changing her city…) instead of waiting for the minute tick. */
  refreshMoment: () => void;
  /** The page being shown, for its icon and accent. */
  route: ConsoleRoute;
}

export const ConsoleContext = createContext<ConsoleContextValue>({
  notify: () => {},
  markClean: () => {},
  navigate: () => {},
  moment: null,
  refreshMoment: () => {},
  route: ROUTES[0]!
});

export const useConsole = () => useContext(ConsoleContext);

/* ------------------------------------------------------------- errors */

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const kind = adminFailureKind(error);
    if (kind === 'unauthorized') return '管理令牌已失效，请重新输入。';
    if (kind === 'flag-disabled') return `这个功能没有开启：${error.message}`;
    if (kind === 'provider-unconfigured') return `还没有配置对应的服务：${error.message}`;
    return error.message || `请求失败（${error.status}）`;
  }
  if (error instanceof Error) return error.message;
  return '操作没有完成';
}

/* -------------------------------------------------------------- hooks */

export interface Loaded<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  reload: () => Promise<void>;
  setData: (next: T | null | ((old: T | null) => T | null)) => void;
}

/** Loads once on mount (and when deps change); keeps the last good data while reloading. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[] = []): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const latest = useRef(load);
  latest.current = load;
  const seq = useRef(0);
  const reload = useCallback(async () => {
    const id = ++seq.current;
    setLoading(true);
    try {
      const next = await latest.current();
      if (id === seq.current) { setData(next); setError(null); }
    } catch (e) {
      if (id === seq.current) setError(e);
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void reload(); }, deps);
  return { data, error, loading, reload, setData };
}

/**
 * Wraps an async action: tracks busy state, reports failures as a toast and
 * optionally reports success. Returns the action's result, or undefined on failure.
 */
export function useAction() {
  const { notify } = useConsole();
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(async <R,>(key: string, action: () => Promise<R>, success?: string): Promise<R | undefined> => {
    setBusy(key);
    try {
      const result = await action();
      if (success) notify(success, 'ok');
      return result;
    } catch (e) {
      notify(errorMessage(e), 'bad');
      return undefined;
    } finally {
      setBusy(null);
    }
  }, [notify]);
  return { run, busy };
}

/* ------------------------------------------------------------- layout */

export function Page({ title, intro, register = 'system', actions, children, headless }: {
  title: string; intro?: ReactNode; register?: 'her' | 'system'; actions?: ReactNode; children: ReactNode;
  /** The title is still announced to screen readers, but something else on screen already says it. */
  headless?: boolean;
}) {
  const { route } = useConsole();
  return (
    <section className="cs-page" data-register={register} aria-labelledby="cs-page-title" style={{ '--h': route.hue } as CSSProperties}>
      <header className={headless ? 'cs-sr' : 'cs-page-head'}>
        <span className="cs-emblem" aria-hidden="true"><Icon name={routeIcon(route.slug)} size={26} /></span>
        <div className="cs-page-title">
          <h1 id="cs-page-title">{title}</h1>
          {intro && <p>{intro}</p>}
        </div>
        {actions && <div className="cs-actions cs-page-actions">{actions}</div>}
      </header>
      {children}
    </section>
  );
}

const PHONE_QUERY = '(max-width: 760px)';

/** True on phone-width screens; follows rotation and window resizes. */
export function useIsPhone(): boolean {
  const [phone, setPhone] = useState(() => typeof window !== 'undefined' && window.matchMedia(PHONE_QUERY).matches);
  useEffect(() => {
    const query = window.matchMedia(PHONE_QUERY);
    const update = () => setPhone(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return phone;
}

/**
 * A titled block. The explanation stays folded behind a help icon so pages read as content, not
 * prose. On phones a section collapses to one tappable row, so a page opens as a short index;
 * the body stays mounted while folded, so half-filled forms and loaded data survive.
 */
export function Section({ title, desc, wide, children, id, defaultOpen }: {
  title: string; desc?: ReactNode; wide?: boolean; children: ReactNode; id?: string;
  /** Start expanded on phones too (pages people open to read, like the landing page). */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const phone = useIsPhone();
  const [expanded, setExpanded] = useState(() => defaultOpen || !(typeof window !== 'undefined' && window.matchMedia(PHONE_QUERY).matches));
  const descId = useId();
  const bodyId = useId();
  const { route } = useConsole();
  const folded = phone && !expanded;
  const mark = <span className="cs-mark" aria-hidden="true"><Icon name={sectionIcon(title, routeIcon(route.slug))} size={16} /></span>;
  return (
    <section className="cs-section" data-wide={wide ? 'true' : undefined} data-folded={folded ? '' : undefined} data-phone={phone ? '' : undefined} id={id}>
      <header className="cs-section-head">
        <h2>
          {phone ? (
            <button type="button" className="cs-section-toggle" aria-expanded={expanded} aria-controls={bodyId} onClick={() => setExpanded((v) => !v)}>
              {mark}<span className="cs-section-name">{title}</span><Icon name="chevron" size={18} className="cs-chevron" />
            </button>
          ) : <>{mark}{title}</>}
        </h2>
        {desc && !folded && (
          <button type="button" className="cs-info" aria-expanded={open} aria-controls={descId} aria-label={open ? '收起说明' : '这一节是做什么的'}
            title={open ? '收起说明' : '这一节是做什么的'} onClick={() => setOpen((v) => !v)}>
            <Icon name="info" size={16} />
          </button>
        )}
      </header>
      {desc && <p className="cs-section-desc" id={descId} hidden={!open || folded}>{desc}</p>}
      <div className="cs-section-body" id={bodyId} hidden={folded}>{children}</div>
    </section>
  );
}
export function Tabs<T extends string>({ tabs, value, onChange, label }: {
  tabs: Array<{ id: T; label: string }>; value: T; onChange: (id: T) => void; label: string;
}) {
  return (
    <div className="cs-tabs" role="tablist" aria-label={label}>
      {tabs.map((tab) => (
        <button key={tab.id} type="button" role="tab" className="cs-tab" aria-selected={tab.id === value} onClick={() => onChange(tab.id)}>
          {tab.label}
        </button>
      ))}
    </div>
  );
}

/* --------------------------------------------------------------- form */

export function Fields({ children }: { children: ReactNode }) {
  return <div className="cs-fields">{children}</div>;
}

export function Field({ label, hint, error, full, children }: {
  label: string; hint?: ReactNode; error?: string | null; full?: boolean; children: ReactNode;
}) {
  return (
    <label className="cs-field" data-span={full ? 'full' : undefined}>
      <span className="cs-field-label">{label}</span>
      {children}
      {error ? <span className="cs-field-error">{error}</span> : hint ? <span className="cs-field-hint">{hint}</span> : null}
    </label>
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`cs-input ${props.className ?? ''}`} />;
}

export function TextArea({ voice, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & { voice?: 'her' }) {
  return <textarea {...props} data-voice={voice} className={`cs-textarea ${props.className ?? ''}`} />;
}

export function Select({ options, ...props }: SelectHTMLAttributes<HTMLSelectElement> & {
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <select {...props} className={`cs-select ${props.className ?? ''}`}>
      {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  );
}

/* ------------------------------------------------------- date & time */

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const pad2 = (n: number) => String(n).padStart(2, '0');

/** YYYY-MM-DD of "now" shifted by a zone offset in minutes (UTC fields read as that zone's wall clock). */
function dayIn(offsetMinutes: number, addDays = 0): string {
  const d = new Date(Date.now() + offsetMinutes * 60_000 + addDays * 86_400_000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function dayLabel(day: string, today: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d!));
  const base = `${m}/${d} ${WEEKDAYS[date.getUTCDay()]}`;
  const diff = Math.round((date.getTime() - new Date(`${today}T00:00:00Z`).getTime()) / 86_400_000);
  const near: Record<number, string> = { [-1]: '昨天', 0: '今天', 1: '明天', 2: '后天' };
  return near[diff] ? `${near[diff]}（${base}）` : base;
}

/**
 * Pick a day and a time from two lists instead of typing into a date field.
 * The value is a wall-clock "YYYY-MM-DDTHH:mm" (or '' for none) in the zone given by offsetMinutes,
 * the same shape <input type="datetime-local"> produces, so callers keep their conversions.
 */
export function DateTimePicker({ value, onChange, offsetMinutes = -new Date().getTimezoneOffset(), days = 14, step = 15, emptyLabel = '不定', label }: {
  value: string; onChange: (next: string) => void; offsetMinutes?: number; days?: number; step?: number; emptyLabel?: string; label: string;
}) {
  const today = dayIn(offsetMinutes);
  const [day = '', time = ''] = value ? value.split('T') : [];
  const dayList = Array.from({ length: days }, (_, i) => dayIn(offsetMinutes, i));
  if (day && !dayList.includes(day)) dayList.unshift(day);
  const times = Array.from({ length: (24 * 60) / step }, (_, i) => `${pad2(Math.floor((i * step) / 60))}:${pad2((i * step) % 60)}`);
  const hm = time.slice(0, 5);
  if (hm && !times.includes(hm)) times.push(hm);
  times.sort();
  /** A sensible time when only the day is picked: the next slot today, otherwise the morning. */
  const defaultTime = (pickedDay: string) => {
    if (pickedDay !== today) return '09:00';
    const now = new Date(Date.now() + offsetMinutes * 60_000);
    const next = Math.ceil((now.getUTCHours() * 60 + now.getUTCMinutes() + 1) / step) * step;
    return next >= 24 * 60 ? '23:45' : `${pad2(Math.floor(next / 60))}:${pad2(next % 60)}`;
  };
  return (
    <span className="cs-dt">
      <select className="cs-select" aria-label={`${label}：哪天`} value={day}
        onChange={(e) => onChange(e.target.value ? `${e.target.value}T${hm || defaultTime(e.target.value)}` : '')}>
        <option value="">{emptyLabel}</option>
        {dayList.map((d) => <option key={d} value={d}>{dayLabel(d, today)}</option>)}
      </select>
      <select className="cs-select" aria-label={`${label}：几点`} value={hm} disabled={!day}
        onChange={(e) => onChange(`${day}T${e.target.value}`)}>
        {!hm && <option value="">几点</option>}
        {times.map((t) => <option key={t} value={t}>{t}</option>)}
      </select>
    </span>
  );
}

type RangePreset = 'all' | 'today' | 'week' | 'month' | 'custom';

/** Date filter as one tap: all / today / last 7 / last 30 days, with exact dates only when asked for. */
export function DateRange({ from, to, onChange, label = '时间' }: {
  from: string; to: string; onChange: (from: string, to: string) => void; label?: string;
}) {
  const local = -new Date().getTimezoneOffset();
  const today = dayIn(local);
  const presets: Array<[RangePreset, string, string, string]> = [
    ['all', '全部', '', ''],
    ['today', '今天', today, today],
    ['week', '最近 7 天', dayIn(local, -6), today],
    ['month', '最近 30 天', dayIn(local, -29), today]
  ];
  const matched = presets.find(([, , f, t]) => f === from && t === to)?.[0];
  const [custom, setCustom] = useState(!matched);
  const active: RangePreset = custom ? 'custom' : matched ?? 'custom';
  return (
    <div className="cs-range" role="group" aria-label={label}>
      <div className="cs-chips">
        {presets.map(([id, text, f, t]) => (
          <button key={id} type="button" className="cs-chip" aria-pressed={active === id} onClick={() => { setCustom(false); onChange(f, t); }}>{text}</button>
        ))}
        <button type="button" className="cs-chip" aria-pressed={active === 'custom'} onClick={() => setCustom(true)}>自定义</button>
      </div>
      {active === 'custom' && (
        <div className="cs-range-custom">
          <input className="cs-input" type="date" aria-label="从哪天" value={from} max={to || undefined} onChange={(e) => onChange(e.target.value, to)} />
          <span className="cs-muted">到</span>
          <input className="cs-input" type="date" aria-label="到哪天" value={to} min={from || undefined} onChange={(e) => onChange(from, e.target.value)} />
        </div>
      )}
    </div>
  );
}

export function Switch({ checked, onChange, label, disabled }: {
  checked: boolean; onChange: (next: boolean) => void; label: ReactNode; disabled?: boolean;
}) {
  return (
    <label className="cs-switch">
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

/* ------------------------------------------------------------ buttons */

type ButtonKind = 'primary' | 'quiet' | 'text' | 'danger' | 'danger-solid';

export function Button({ kind = 'primary', size, busy, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
  kind?: ButtonKind; size?: 'sm'; busy?: boolean;
}) {
  return (
    <button
      type="button"
      {...props}
      className="cs-btn"
      data-kind={kind === 'primary' ? undefined : kind}
      data-size={size}
      aria-busy={busy || undefined}
      disabled={props.disabled || busy}
    >
      {children}
    </button>
  );
}

/** Two-step destructive action without a browser dialog: the first click asks, the second does it. */
export function ConfirmButton({ label, question, confirmLabel, onConfirm, busy, size = 'sm', disabled }: {
  label: string; question: string; confirmLabel?: string; onConfirm: () => void | Promise<unknown>;
  busy?: boolean; size?: 'sm'; disabled?: boolean;
}) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return <Button kind="danger" size={size} busy={busy} disabled={disabled} onClick={() => setAsking(true)}>{label}</Button>;
  }
  return (
    <span className="cs-confirm" role="group" aria-label={question}>
      <span className="cs-confirm-text">{question}</span>
      <Button kind="danger-solid" size={size} busy={busy} onClick={async () => { await onConfirm(); setAsking(false); }}>
        {confirmLabel ?? label}
      </Button>
      <Button kind="text" size={size} onClick={() => setAsking(false)}>取消</Button>
    </span>
  );
}

/**
 * Two-step action that spends paid quota (image test, voice preview, video, AI analysis).
 * Not destructive, so it asks in amber rather than danger red.
 */
export function CostButton({ label, question, confirmLabel, onConfirm, busy, disabled, kind = 'quiet', size }: {
  label: ReactNode; question: string; confirmLabel?: string; onConfirm: () => void | Promise<unknown>;
  busy?: boolean; disabled?: boolean; kind?: 'primary' | 'quiet'; size?: 'sm';
}) {
  const [asking, setAsking] = useState(false);
  if (!asking) return <Button kind={kind} size={size} busy={busy} disabled={disabled} onClick={() => setAsking(true)}>{label}</Button>;
  return (
    <span className="cs-confirm" role="group" aria-label={question}>
      <span className="cs-cost-text">{question}</span>
      <Button size={size} busy={busy} onClick={async () => { await onConfirm(); setAsking(false); }}>{confirmLabel ?? '确定'}</Button>
      <Button kind="text" size={size} onClick={() => setAsking(false)}>取消</Button>
    </span>
  );
}

/* ----------------------------------------------------- status & data */

export function Status({ tone = 'off', children }: { tone?: Tone; children: ReactNode }) {
  return <span className="cs-status" data-tone={tone}>{children}</span>;
}

export function Tag({ tone, children }: { tone?: Exclude<Tone, 'off'>; children: ReactNode }) {
  return <span className="cs-tag" data-tone={tone}>{children}</span>;
}

export function Facts({ items }: { items: Array<[string, ReactNode]> }) {
  return (
    <dl className="cs-facts">
      {items.map(([label, value]) => (
        <div className="cs-fact" key={label}><dt>{label}</dt><dd data-empty={value === null || value === undefined || value === '' || value === '—' ? '' : undefined}>{value ?? '—'}</dd></div>
      ))}
    </dl>
  );
}

/** value in 0..1 */
export function Meter({ label, value, tone, display }: { label: string; value: number; tone?: 'warn' | 'bad'; display?: string }) {
  const pct = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  return (
    <div className="cs-meter" data-tone={tone}>
      <span>{label}</span>
      <span className="cs-meter-track" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct * 100)}>
        <span className="cs-meter-fill" style={{ width: `${pct * 100}%`, display: 'block' }} />
      </span>
      <span className="cs-meter-value">{display ?? Math.round(pct * 100)}</span>
    </div>
  );
}

export function Callout({ tone, children }: { tone?: Exclude<Tone, 'off'>; children: ReactNode }) {
  return <div className="cs-callout" data-tone={tone} role={tone === 'bad' ? 'alert' : undefined}>{children}</div>;
}

export function Empty({ children, action, icon }: { children: ReactNode; action?: ReactNode; icon?: string }) {
  const { route } = useConsole();
  return (
    <div className="cs-empty">
      <span className="cs-empty-art" aria-hidden="true"><Icon name={icon ?? routeIcon(route.slug)} size={28} /></span>
      <div className="cs-empty-text"><p>{children}</p>{action}</div>
    </div>
  );
}

export function Loading({ children = '正在读取…' }: { children?: ReactNode }) {
  return <div className="cs-loading" role="status">{children}</div>;
}

/** Standard rendering for a useLoad result: spinner, error with retry, or the content. */
export function Loadable<T>({ state, children, label }: { state: Loaded<T>; children: (data: T) => ReactNode; label?: string }) {
  if (state.data !== null) return <>{children(state.data)}</>;
  if (state.error) {
    return (
      <Callout tone="bad">
        {label ? `${label}读取失败：` : ''}{errorMessage(state.error)}{' '}
        <Button kind="text" size="sm" onClick={() => void state.reload()}>重试</Button>
      </Callout>
    );
  }
  return <Loading />;
}

/* --------------------------------------------------------- formatting */

const dateTime = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const fullDateTime = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

export function fmtTime(value: string | number | null | undefined, full = false): string {
  if (value === null || value === undefined || value === '') return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return (full || date.getFullYear() !== new Date().getFullYear() ? fullDateTime : dateTime).format(date);
}

export function fmtAgo(value: string | number | null | undefined): string {
  if (!value) return '—';
  const ms = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(ms)) return '—';
  const s = Math.round(ms / 1000);
  if (s < 0) return fmtTime(value);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} 天前`;
  return fmtTime(value);
}

export function fmtBytes(value: unknown): string {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function fmtDuration(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d) return `${d} 天 ${h} 小时`;
  if (h) return `${h} 小时 ${m} 分钟`;
  return `${m} 分钟`;
}

export function onOff(value: unknown): string {
  return value ? '开启' : '关闭';
}
