import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { getToken } from '../lib/api.js';
import { fetchAuthenticatedMedia, releaseMediaUrl, safeDownloadName } from '../lib/authenticatedMedia.js';
import { useAuthenticatedMedia } from '../lib/useAuthenticatedMedia.js';
import type { ChatMessage, MessagePart } from '../lib/types.js';
import { AudioBubble } from './AudioBubble.js';
import { AuthenticatedImage } from './AuthenticatedMedia.js';

/** One line of the quoted message: its text, or what kind of media it was. */
function quotedPreview(message: ChatMessage): string {
  for (const part of message.content) {
    if (part.type === 'text' && part.text?.trim()) return part.text.trim();
    if (part.type === 'audio') return part.transcript?.trim() ? `[语音] ${part.transcript.trim()}` : '[语音]';
    if (part.type === 'image') return '[图片]';
    if (part.type === 'sticker') return '[表情]';
    if (part.type === 'file') return `[文件] ${part.media?.name ?? ''}`.trim();
  }
  return '[空消息]';
}

function formatClock(iso: string): string { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; }
function formatBytes(n: number): string { return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`; }
function messageText(message: ChatMessage): string { return message.content.map((part) => part.type === 'text' ? part.text ?? '' : part.type === 'audio' ? part.transcript ?? '' : '').filter(Boolean).join('\n'); }
function selectedTextWithin(container: HTMLElement | null): string {
  const selection = window.getSelection();
  if (!container || !selection || selection.isCollapsed || selection.rangeCount === 0) return '';
  const range = selection.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return '';
  return selection.toString().trim();
}
async function copy(text: string): Promise<void> { if (navigator.clipboard) await navigator.clipboard.writeText(text); else { const area = document.createElement('textarea'); area.value = text; document.body.appendChild(area); area.select(); document.execCommand('copy'); area.remove(); } }
async function savePart(part: MessagePart): Promise<void> {
  if (!part.media) return;
  const result = await fetchAuthenticatedMedia(part.media.url, {
    scope: 'user',
    token: getToken(),
    expected: part.type === 'image' ? 'image' : part.type === 'audio' ? 'audio' : 'file'
  });
  try {
    const link = document.createElement('a');
    link.href = result.url;
    link.download = safeDownloadName(part.media.name, `sooya-${part.media.id}`);
    link.click();
  } finally {
    window.setTimeout(() => releaseMediaUrl(result.url), 1000);
  }
}

function ImagePart({ part, onOpen }: { part: MessagePart; onOpen?: (mediaId: string) => void }) {
  const [failed, setFailed] = useState(false);
  const media = useAuthenticatedMedia(part.media?.url, 'user', 'image');
  if (part.status === 'failed') return <div className="bubble bubble-note">图片没有发出去{part.error ? `：${part.error}` : ''}</div>;
  if (part.status === 'pending' || !part.media) return <div className="bubble bubble-note pulsing">图片生成中…</div>;
  if (failed) return <div className="bubble bubble-note">图片加载失败</div>;
  const ratio = part.media.width && part.media.height ? part.media.width / part.media.height : undefined;
  const { url, error } = media;
  const alt = part.media.name ?? '图片';
  if (error) return <div className="bubble bubble-note">{error}</div>;
  return <button className="image-part" type="button" onClick={() => onOpen ? onOpen(part.media!.id) : window.dispatchEvent(new CustomEvent('sooya:open-image', { detail: { id: part.media!.id } }))} aria-label="查看大图" data-media-id={part.media.id} data-src={url ?? ''} data-alt={alt}>{url && <img src={url} alt={alt} loading="lazy" style={ratio ? { aspectRatio: String(ratio) } : undefined} onError={() => setFailed(true)} />}</button>;
}
function StickerPart({ part }: { part: MessagePart }) { const [failed, setFailed] = useState(false); if (!part.media || failed) return null; return <AuthenticatedImage className="sticker-part" path={part.media.url} scope="user" alt={String(part.meta?.stickerName ?? '表情')} loading="lazy" onError={() => setFailed(true)} />; }
function FilePart({ part }: { part: MessagePart }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!part.media) return <div className="bubble bubble-note">文件不可用</div>;
  /* `void savePart(part)` used to drop the rejection on the floor: a cleaned-up
   * or unreachable file failed with no visible trace, so the user just kept
   * clicking. Surface it the same way a broken image does. */
  const save = async () => {
    setError(null);
    setBusy(true);
    try {
      await savePart(part);
    } catch (err) {
      setError(err instanceof Error ? err.message : '文件下载失败');
    } finally {
      setBusy(false);
    }
  };
  return <>
    <button className="bubble bubble-file" type="button" disabled={busy} onClick={() => void save()}><span className="file-icon">▣</span><span className="file-meta"><span className="file-name">{part.media.name ?? '文件'}</span><span className="file-size">{busy ? '下载中…' : formatBytes(part.media.bytes)}</span></span></button>
    {error && <div className="bubble bubble-note file-error" role="status">{error}</div>}
  </>;
}

interface Props {
  message: ChatMessage; personaName: string; avatar: string; userAvatar: string; showAvatar: boolean;
  /** The message being replied to, when it is still loaded. */
  quoted?: ChatMessage | null; quotedLabel?: string;
  /**
   * Id of the message directly above this one. Every assistant reply carries
   * `replyTo` pointing at the message that triggered it, which in a 1v1 chat is
   * almost always the line right above — rendering a quote of it just repeats what
   * the user can already see. Quoting anything further back is still shown.
   */
  previousId?: string | null;
  onRetry?: (message: ChatMessage) => void; onResend?: (message: ChatMessage) => void; onQuote?: (message: ChatMessage) => void; onWithdraw?: (message: ChatMessage) => void; onOpenImage?: (mediaId: string) => void; onNotice?: (text: string) => void;
}

export const MessageItem = memo(function MessageItem({ message, personaName, avatar, userAvatar, showAvatar, quoted, quotedLabel, previousId, onRetry, onResend, onQuote, onWithdraw, onOpenImage, onNotice }: Props) {
  const mine = message.role === 'user';
  // Every assistant turn carries `replyTo` for stream recovery, so a preview is only
  // worth showing when it says something the bubble order does not: not the message
  // right above, and not a target that scrolled out of the loaded window — for those
  // the placeholder is pure noise. A user message is different: the quote was chosen
  // deliberately, so say the original is gone rather than dropping it silently.
  const showReplyPreview = Boolean(message.replyTo) && message.replyTo !== previousId && (Boolean(quoted) || mine);
  const visible = message.content.filter((part) => part.type !== 'system');
  const failedMessage = message.status === 'failed';
  const [menu, setMenu] = useState<{ x: number; y: number; selectedText: string } | null>(null);
  const messageRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const press = useRef<{ timer: number; pointerId: number; x: number; y: number } | null>(null);
  const cancelPress = useCallback(() => {
    const current = press.current;
    if (!current) return;
    window.clearTimeout(current.timer);
    press.current = null;
  }, []);

  useEffect(() => {
    const cancelOnHidden = () => { if (document.visibilityState !== 'visible') cancelPress(); };
    window.addEventListener('scroll', cancelPress, true);
    window.addEventListener('blur', cancelPress);
    document.addEventListener('visibilitychange', cancelOnHidden);
    return () => {
      window.removeEventListener('scroll', cancelPress, true);
      window.removeEventListener('blur', cancelPress);
      document.removeEventListener('visibilitychange', cancelOnHidden);
      cancelPress();
    };
  }, [cancelPress]);

  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector<HTMLElement>('button')?.focus();
    const close = (event: Event) => { if (!menuRef.current?.contains(event.target as Node)) setMenu(null); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenu(null); };
    window.addEventListener('pointerdown', close); window.addEventListener('keydown', key);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', key); };
  }, [menu]);

  if (message.role === 'system') return <div className="system-row"><span>{message.content.map((part) => part.text).filter(Boolean).join(' ')}</span></div>;
  const openMenu = (x: number, y: number) => setMenu({
    x: Math.max(8, Math.min(window.innerWidth - 220, x)),
    y: Math.max(8, Math.min(window.innerHeight - 360, y)),
    selectedText: selectedTextWithin(messageRef.current)
  });
  const text = messageText(message);
  const image = visible.find((part) => part.type === 'image' && part.media);
  const audio = visible.find((part) => part.type === 'audio' && part.media);
  const withdrawable = mine && message.status === 'sent' && !message.pendingLocal && !message.meta?.withdrawnAt && Date.now() - Date.parse(message.createdAt) <= 5 * 60_000;
  const act = async (work: () => void | Promise<void>, success?: string) => { setMenu(null); try { await work(); if (success) onNotice?.(success); } catch (error) { onNotice?.((error as Error).message); } };

  return (
    <div ref={messageRef} className={`msg-row ${mine ? 'mine' : 'theirs'}`} data-role={message.role} data-status={message.status} data-testid="message"
      onContextMenu={(event) => { event.preventDefault(); openMenu(event.clientX, event.clientY); }}
      onPointerDown={(event) => {
        if (event.pointerType === 'mouse') return;
        cancelPress();
        const pointerId = event.pointerId;
        const timer = window.setTimeout(() => {
          if (press.current?.pointerId !== pointerId) return;
          press.current = null;
          openMenu(event.clientX, event.clientY);
        }, 520);
        press.current = { timer, pointerId, x: event.clientX, y: event.clientY };
      }}
      onPointerMove={(event) => { const current = press.current; if (current?.pointerId === event.pointerId && Math.hypot(event.clientX - current.x, event.clientY - current.y) > 9) cancelPress(); }}
      onPointerUp={cancelPress} onPointerCancel={cancelPress} onLostPointerCapture={cancelPress}>
      <div className="avatar-slot">{showAvatar && <AuthenticatedImage className="avatar" path={mine ? userAvatar : avatar} scope="user" alt={mine ? '我' : personaName} draggable={false} />}</div>
      <div className="msg-body">
        {showReplyPreview && (
          <div className="message-reply-preview" data-testid="reply-preview">
            <span className="reply-author">{quotedLabel || '原消息'}</span>
            <span className="reply-text">{quoted ? quotedPreview(quoted) : '原消息已不在当前记录中'}</span>
          </div>
        )}
        <div className="bubbles">{visible.map((part) => { switch (part.type) { case 'text': return part.text ? <div key={part.id} className={`bubble bubble-text ${mine ? 'mine' : 'theirs'}`} data-testid="text-bubble">{part.text}</div> : null; case 'sticker': return <StickerPart key={part.id} part={part} />; case 'image': return <ImagePart key={part.id} part={part} onOpen={onOpenImage} />; case 'audio': return <AudioBubble key={part.id} part={part} mine={mine} />; case 'file': return <FilePart key={part.id} part={part} />; default: return null; } })}</div>
        <div className="msg-meta"><span className="clock">{formatClock(message.createdAt)}</span>{message.pendingLocal && message.status !== 'failed' && <span className="sending-dot" aria-label="发送中" />}{failedMessage && <span className="failed-flag">发送失败{onRetry && <button type="button" className="retry-btn" onClick={() => onRetry(message)}>重试</button>}</span>}<button type="button" className="message-menu-button" aria-label="消息操作" onClick={(event) => openMenu(event.clientX, event.clientY)}>···</button></div>
      </div>
      {menu && <div ref={menuRef} className="message-action-menu" role="menu" aria-label="消息操作" style={{ position: 'fixed', left: menu.x, top: menu.y, zIndex: 10000 }}>
        {text && <button role="menuitem" type="button" onClick={() => void act(() => copy(text), '已复制全文')}>复制全文</button>}
        {text && <button role="menuitem" type="button" disabled={!menu.selectedText} onClick={() => void act(() => copy(menu.selectedText), '已复制文本')}>复制选中文本</button>}
        {onQuote && <button role="menuitem" type="button" onClick={() => void act(() => onQuote(message))}>引用回复</button>}
        {mine && !message.pendingLocal && onResend && <button role="menuitem" type="button" onClick={() => void act(() => onResend(message))}>重新发送</button>}
        {failedMessage && onRetry && <button role="menuitem" type="button" onClick={() => void act(() => onRetry(message))}>重试</button>}
        {withdrawable && onWithdraw && <button role="menuitem" type="button" className="danger" onClick={() => void act(() => onWithdraw(message))}>撤回（保留占位）</button>}
        {image?.media && <><button role="menuitem" type="button" onClick={() => void act(() => onOpenImage?.(image.media!.id))}>查看图片</button><button role="menuitem" type="button" onClick={() => void act(() => savePart(image), '图片已保存')}>保存图片</button><button role="menuitem" type="button" onClick={() => void act(() => { window.location.href = `/gallery?media=${encodeURIComponent(image.media!.id)}`; })}>进入图库</button></>}
        {audio?.media && <><button role="menuitem" type="button" onClick={() => void act(() => savePart(audio), '语音已保存')}>保存语音</button>{audio.transcript && <button role="menuitem" type="button" onClick={() => void act(() => copy(audio.transcript!), '转写文本已复制')}>复制转写</button>}</>}
      </div>}
    </div>
  );
});
