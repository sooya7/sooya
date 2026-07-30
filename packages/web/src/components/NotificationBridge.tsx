import { useCallback, useEffect, useRef, useState } from 'react';
import { requestPushApi } from '../lib/pushApi.js';
import { disablePushSubscription } from '../lib/pushToggle.js';
import { createVisibilitySynchronizer } from '../lib/visibilitySync.js';

type PushState = 'unsupported' | 'prompt' | 'subscribed' | 'denied' | 'working' | 'error';

/** Remembers that the user already dealt with this bar, so it stops occupying the chat. */
const HIDDEN_KEY = 'sooya.push.optin.hidden';

function readHidden(): boolean {
  try {
    return window.localStorage.getItem(HIDDEN_KEY) === '1';
  } catch {
    return false;
  }
}

function writeHidden(hidden: boolean): void {
  try {
    if (hidden) window.localStorage.setItem(HIDDEN_KEY, '1');
    else window.localStorage.removeItem(HIDDEN_KEY);
  } catch {
    // Storage denied: the bar simply comes back next load.
  }
}

function fromBase64Url(value: string): ArrayBuffer {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
  return bytes.buffer;
}

async function currentSubscription(): Promise<PushSubscription | null> {
  if (!('serviceWorker' in navigator)) return null;
  const registration = await navigator.serviceWorker.ready;
  return await registration.pushManager.getSubscription();
}

async function subscribe(): Promise<PushSubscription> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error(permission === 'denied' ? '通知权限已被浏览器拒绝' : '没有获得通知权限');
  const registration = await navigator.serviceWorker.ready;
  const { publicKey } = await requestPushApi<{ publicKey: string }>('/api/push/public-key');
  const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromBase64Url(publicKey) });
  await requestPushApi('/api/push/subscribe', { method: 'POST', body: JSON.stringify(subscription.toJSON()) });
  return subscription;
}

export function NotificationBridge() {
  const supported = typeof window !== 'undefined' && 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;
  const [state, setState] = useState<PushState>(() => !supported ? 'unsupported' : Notification.permission === 'denied' ? 'denied' : 'prompt');
  const [subscription, setSubscription] = useState<PushSubscription | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [hidden, setHidden] = useState(() => supported && readHidden());
  const mounted = useRef(true);

  useEffect(() => () => { mounted.current = false; }, []);

  /**
   * The browser is the only authority on whether this device is subscribed. Every
   * action ends here, so the button can never disagree with reality — that mismatch
   * is what made the toggle look stuck: an action that threw left the old label in
   * place with no visible change.
   */
  const syncFromBrowser = useCallback(async (): Promise<PushSubscription | null> => {
    const value = await currentSubscription();
    if (!mounted.current) return value;
    setSubscription(value);
    setState(value ? 'subscribed' : Notification.permission === 'denied' ? 'denied' : 'prompt');
    return value;
  }, []);

  useEffect(() => {
    if (!supported) return;
    void syncFromBrowser().catch(() => { if (mounted.current) setState('error'); });
  }, [supported, syncFromBrowser]);

  useEffect(() => {
    if (!subscription) return;
    const synchronizer = createVisibilitySynchronizer(
      (visible) => requestPushApi('/api/push/visibility', {
        method: 'POST',
        body: JSON.stringify({ endpoint: subscription.endpoint, visible })
      }),
      () => document.visibilityState === 'visible'
    );
    const sync = () => synchronizer.notify();
    sync();
    document.addEventListener('visibilitychange', sync);
    window.addEventListener('focus', sync);
    window.addEventListener('blur', sync);
    return () => {
      document.removeEventListener('visibilitychange', sync);
      window.removeEventListener('focus', sync);
      window.removeEventListener('blur', sync);
      synchronizer.dispose();
    };
  }, [subscription]);

  if (!supported) return null;

  const enable = async () => {
    setState('working');
    setMessage(null);
    try {
      await subscribe();
      await syncFromBrowser();
      if (mounted.current) setMessage('后台通知已开启');
    } catch (error) {
      // Re-read first: the subscription may exist even though a later step failed.
      await syncFromBrowser().catch(() => undefined);
      if (!mounted.current) return;
      if (Notification.permission === 'denied') setState('denied');
      setMessage((error as Error).message);
    }
  };

  const disable = async () => {
    const target = subscription;
    if (!target) return;
    setState('working');
    setMessage(null);
    try {
      const result = await disablePushSubscription(target);
      const remaining = await syncFromBrowser();
      if (!mounted.current) return;
      setMessage(remaining ? '订阅仍然存在，请再试一次' : result.warning ?? '后台通知已关闭');
    } catch (error) {
      await syncFromBrowser().catch(() => undefined);
      if (mounted.current) setMessage((error as Error).message);
    }
  };

  const on0 = Boolean(subscription);

  const dismiss = () => {
    writeHidden(true);
    setMessage(null);   // otherwise the "keep showing while there is a message" rule wins
    setHidden(true);
  };

  if (state === 'denied') {
    if (hidden) return null;
    return (
      <div className="notification-optin" role="status">
        <span>通知权限已被浏览器禁用，请在站点设置中重新允许。</span>
        <button type="button" className="notification-dismiss" aria-label="不再提示" onClick={dismiss}>×</button>
      </div>
    );
  }

  // Once the user has answered, the bar has nothing left to ask; keeping it on screen
  // forever was the \"stuck\" part of this bug. It never hides a pending action or an
  // error, and it always leaves the small bell behind — hiding the bar used to be a
  // one-way door, with no way back to the toggle short of clearing site data.
  if (hidden && state !== 'working' && !message) {
    return (
      <button
        type="button"
        className={`notification-reopen${on0 ? ' is-on' : ''}`}
        data-testid="push-reopen"
        aria-label={on0 ? '通知设置：后台通知已开启' : '通知设置：后台通知已关闭'}
        title="通知设置"
        onClick={() => { writeHidden(false); setHidden(false); }}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M12 3a5 5 0 0 0-5 5v3.6L5.4 14a1 1 0 0 0 .8 1.6h11.6a1 1 0 0 0 .8-1.6L17 11.6V8a5 5 0 0 0-5-5Z" />
          <path d="M10 18.2a2 2 0 0 0 4 0Z" />
          {!on0 && <path className="notification-reopen-slash" d="M4 4l16 16" />}
        </svg>
      </button>
    );
  }

  const on = Boolean(subscription);
  return (
    <div className="notification-optin" role="status" data-testid="push-controls" data-push-state={state}>
      <span>{on ? 'SOOYA 后台通知已开启' : '开启通知，PWA 关闭后也能收到回复'}</span>
      {message && <small>{message}</small>}
      <button type="button" disabled={state === 'working'} onClick={() => void (on ? disable() : enable())}>
        {state === 'working' ? '处理中…' : on ? '关闭通知' : '开启通知'}
      </button>
      <button type="button" className="notification-dismiss" aria-label="收起通知提示" onClick={dismiss}>×</button>
    </div>
  );
}
