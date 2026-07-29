import { useEffect, useState } from 'react';

function messagePreview(node: HTMLElement): string {
  const text = [...node.querySelectorAll<HTMLElement>('[data-testid="text-bubble"]')]
    .map((el) => el.innerText.trim())
    .filter(Boolean)
    .join(' ');
  if (text) return text.slice(0, 120);
  if (node.querySelector('.bubble-audio')) return '发来了一条语音';
  if (node.querySelector('.image-part')) return '发来了一张图片';
  if (node.querySelector('.sticker-part')) return '发来了一个表情';
  return '发来了一条新消息';
}

async function showReplyNotification(body: string) {
  const registration = await navigator.serviceWorker?.ready.catch(() => null);
  if (registration?.showNotification) {
    await registration.showNotification('SOOYA', {
      body,
      icon: '/icons/icon.svg',
      badge: '/icons/icon.svg',
      tag: 'sooya-latest-reply',
      data: { url: '/' }
    });
    return;
  }
  new Notification('SOOYA', { body, icon: '/icons/icon.svg', tag: 'sooya-latest-reply' });
}

export function NotificationBridge() {
  const supported = typeof window !== 'undefined' && 'Notification' in window;
  const [permission, setPermission] = useState<NotificationPermission>(() =>
    supported ? Notification.permission : 'denied'
  );

  useEffect(() => {
    if (!supported) return;
    const seen = new WeakSet<Element>();
    const markExisting = () => {
      document.querySelectorAll('[data-testid="message"][data-role="assistant"]').forEach((node) => seen.add(node));
    };
    markExisting();

    const inspect = () => {
      document
        .querySelectorAll<HTMLElement>('[data-testid="message"][data-role="assistant"][data-status="sent"]')
        .forEach((node) => {
          if (seen.has(node)) return;
          seen.add(node);
          if (document.visibilityState !== 'hidden' || Notification.permission !== 'granted') return;
          void showReplyNotification(messagePreview(node));
        });
    };

    const observer = new MutationObserver(inspect);
    observer.observe(document.getElementById('root') ?? document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-status']
    });
    return () => observer.disconnect();
  }, [supported]);

  if (!supported || permission === 'granted' || permission === 'denied') return null;

  return (
    <div className="notification-optin" role="status">
      <span>开启通知，切到后台也能看到 SOOYA 的回复</span>
      <button
        type="button"
        onClick={async () => {
          const result = await Notification.requestPermission();
          setPermission(result);
        }}
      >
        开启通知
      </button>
    </div>
  );
}
