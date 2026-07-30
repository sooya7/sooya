import { useCallback, useEffect, useRef, useState } from 'react';
import { requestPushApi } from '../lib/pushApi.js';
import { disablePushSubscription } from '../lib/pushToggle.js';
import { createVisibilitySynchronizer } from '../lib/visibilitySync.js';

type PushState = 'unsupported' | 'prompt' | 'subscribed' | 'denied' | 'working' | 'error';

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

/**
 * Lives in the top bar next to the control-panel entry: a bell that opens the push
 * toggle on demand.
 *
 * It used to be a bar floating over the conversation, shown by default until
 * dismissed. Two things were wrong with that. It covered the chat — and the service
 * worker update prompt, whose clicks it swallowed outright — and it asked a question
 * nobody had asked it to ask, on every fresh device. Notifications are a setting, so
 * they belong with the settings: nothing appears until the bell is clicked.
 */
export function NotificationBridge() {
  const supported = typeof window !== 'undefined' && 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;
  const [state, setState] = useState<PushState>(() => !supported ? 'unsupported' : Notification.permission === 'denied' ? 'denied' : 'prompt');
  const [subscription, setSubscription] = useState<PushSubscription | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
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

  // A popover with no way out is its own annoyance, so honour the two gestures every
  // user already expects. An action in flight keeps it open: closing mid-subscribe
  // would hide the outcome the user is waiting for.
  useEffect(() => {
    if (!open) return;
    const closeUnlessBusy = () => { if (state !== 'working') setOpen(false); };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') closeUnlessBusy(); };
    const onPointerDown = (event: PointerEvent) => {
      const root = rootRef.current;
      if (root && event.target instanceof Node && !root.contains(event.target)) closeUnlessBusy();
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open, state]);

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

  const on = Boolean(subscription);
  const statusText =
    state === 'denied'
      ? '通知权限已被浏览器禁用，请在站点设置中重新允许。'
      : on
        ? 'SOOYA 后台通知已开启'
        : '开启通知，PWA 关闭后也能收到回复';

  return (
    <div className={`notification-menu${open ? ' is-open' : ''}`} ref={rootRef}>
      <button
        type="button"
        className={`notification-bell${on ? ' is-on' : ''}`}
        data-testid="push-bell"
        aria-label={`通知设置：后台通知${on ? '已开启' : '已关闭'}`}
        aria-expanded={open}
        title="通知设置"
        onClick={() => setOpen((value) => !value)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M12 3a5 5 0 0 0-5 5v3.6L5.4 14a1 1 0 0 0 .8 1.6h11.6a1 1 0 0 0 .8-1.6L17 11.6V8a5 5 0 0 0-5-5Z" />
          <path d="M10 18.2a2 2 0 0 0 4 0Z" />
          {!on && <path className="notification-bell-slash" d="M4 4l16 16" />}
        </svg>
      </button>
      {open && (
        <div className="notification-optin" role="dialog" aria-label="通知设置" data-testid="push-controls" data-push-state={state}>
          <span>{statusText}</span>
          {message && <small>{message}</small>}
          {state !== 'denied' && (
            <button type="button" disabled={state === 'working'} onClick={() => void (on ? disable() : enable())}>
              {state === 'working' ? '处理中…' : on ? '关闭通知' : '开启通知'}
            </button>
          )}
          <button type="button" className="notification-dismiss" aria-label="关闭通知设置" onClick={() => setOpen(false)}>×</button>
        </div>
      )}
    </div>
  );
}
