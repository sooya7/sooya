import { useEffect, useState } from 'react';
import { getToken } from '../lib/api.js';

type PushState = 'unsupported' | 'prompt' | 'subscribed' | 'denied' | 'working' | 'error';

function authHeaders(): Headers {
  const headers = new Headers({ 'content-type': 'application/json' });
  const token = getToken();
  if (token) headers.set('x-sooya-token', token);
  return headers;
}

async function pushRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...init, headers: init.headers ?? authHeaders() });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message ?? body.error ?? `通知请求失败 (${response.status})`);
  return body as T;
}

function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
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
  const { publicKey } = await pushRequest<{ publicKey: string }>('/api/push/public-key');
  const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromBase64Url(publicKey) });
  await pushRequest('/api/push/subscribe', { method: 'POST', body: JSON.stringify(subscription.toJSON()) });
  return subscription;
}

async function unsubscribe(subscription: PushSubscription): Promise<void> {
  await pushRequest('/api/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint: subscription.endpoint }) });
  await subscription.unsubscribe();
}

export function NotificationBridge() {
  const supported = typeof window !== 'undefined' && 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;
  const [state, setState] = useState<PushState>(() => !supported ? 'unsupported' : Notification.permission === 'denied' ? 'denied' : 'prompt');
  const [subscription, setSubscription] = useState<PushSubscription | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!supported) return;
    let active = true;
    void currentSubscription().then((value) => {
      if (!active) return;
      setSubscription(value);
      setState(value ? 'subscribed' : Notification.permission === 'denied' ? 'denied' : 'prompt');
    }).catch(() => active && setState('error'));
    return () => { active = false; };
  }, [supported]);

  useEffect(() => {
    if (!subscription) return;
    const sync = () => {
      void pushRequest('/api/push/visibility', {
        method: 'POST',
        body: JSON.stringify({ endpoint: subscription.endpoint, visible: document.visibilityState === 'visible' })
      }).catch(() => undefined);
    };
    sync();
    document.addEventListener('visibilitychange', sync);
    window.addEventListener('focus', sync);
    window.addEventListener('blur', sync);
    return () => {
      document.removeEventListener('visibilitychange', sync);
      window.removeEventListener('focus', sync);
      window.removeEventListener('blur', sync);
    };
  }, [subscription]);

  if (!supported) return null;

  const enable = async () => {
    setState('working');
    setMessage(null);
    try {
      const value = await subscribe();
      setSubscription(value);
      setState('subscribed');
      setMessage('后台通知已开启');
    } catch (error) {
      setState(Notification.permission === 'denied' ? 'denied' : 'error');
      setMessage((error as Error).message);
    }
  };

  const disable = async () => {
    if (!subscription) return;
    setState('working');
    setMessage(null);
    try {
      await unsubscribe(subscription);
      setSubscription(null);
      setState('prompt');
      setMessage('后台通知已关闭');
    } catch (error) {
      setState('error');
      setMessage((error as Error).message);
    }
  };

  if (state === 'denied') {
    return <div className="notification-optin" role="status"><span>通知权限已被浏览器禁用，请在站点设置中重新允许。</span></div>;
  }

  return (
    <div className="notification-optin" role="status" data-testid="push-controls">
      <span>{subscription ? 'SOOYA 后台通知已开启' : '开启通知，PWA 关闭后也能收到回复'}</span>
      {message && <small>{message}</small>}
      <button type="button" disabled={state === 'working'} onClick={() => void (subscription ? disable() : enable())}>
        {state === 'working' ? '处理中…' : subscription ? '关闭通知' : '开启通知'}
      </button>
    </div>
  );
}
