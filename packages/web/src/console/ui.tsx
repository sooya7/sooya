import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes
} from 'react';
import { ApiError } from '../lib/api.js';
import { adminFailureKind } from '../lib/admin.js';
import type { MomentData } from './Moment.js';

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
}

export const ConsoleContext = createContext<ConsoleContextValue>({
  notify: () => {},
  markClean: () => {},
  navigate: () => {},
  moment: null
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
  return (
    <section className="cs-page" data-register={register} aria-labelledby="cs-page-title">
      <header className={headless ? 'cs-sr' : 'cs-page-head'}>
        <h1 id="cs-page-title">{title}</h1>
        {intro && <p>{intro}</p>}
        {actions && <div className="cs-actions">{actions}</div>}
      </header>
      {children}
    </section>
  );
}

export function Section({ title, desc, wide, children, id }: {
  title: string; desc?: ReactNode; wide?: boolean; children: ReactNode; id?: string;
}) {
  return (
    <section className="cs-section" data-wide={wide ? 'true' : undefined} id={id}>
      <div className="cs-section-head">
        <h2>{title}</h2>
        {desc && <p>{desc}</p>}
      </div>
      <div className="cs-section-body">{children}</div>
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
        <div className="cs-fact" key={label}><dt>{label}</dt><dd>{value ?? '—'}</dd></div>
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

export function Empty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return <div className="cs-empty"><p>{children}</p>{action}</div>;
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
