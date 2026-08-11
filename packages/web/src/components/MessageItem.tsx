import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { getToken } from '../lib/api.js';
import { BUBBLE_IMAGE_CSS_WIDTH, fetchAuthenticatedMedia, mediaThumbnailPath, releaseMediaUrl, safeDownloadName } from '../lib/authenticatedMedia.js';
import { useAuthenticatedMedia } from '../lib/useAuthenticatedMedia.js';
import { api } from '../lib/api.js';
import type { VisibleThought } from '../lib/api.js';
import { getInnerThoughtMode, limitToThreeSentences, nextInnerThoughtMode, setInnerThoughtMode, INNER_THOUGHT_MODES, type InnerThoughtMode } from '../lib/innerThought.js';
import type { ChatMessage, MessagePart } from '../lib/types.js';
import { isReplayableUserMessage, isRetryableFailedMessage } from '../lib/useChat.js';
import { stripModelDirectivesForDisplay } from '../lib/messageDirectives.js';
import { AudioBubble } from './AudioBubble.js';
import { AuthenticatedImage } from './AuthenticatedMedia.js';
import { WebCitations } from './WebCitations.js';

/** One line of the quoted message: its text, or what kind of media it was. */
function quotedPreview(message: ChatMessage): string {
  for (const part of message.content) {
    if (part.type === 'text') {
      const text = stripModelDirectivesForDisplay(part.text);
      if (text) return text;
    }
    if (part.type === 'audio') return part.transcript?.trim() ? `[语音] ${part.transcript.trim()}` : '[语音]';
    if (part.type === 'image') return '[图片]';
    if (part.type === 'sticker') return `[表情：${String(part.meta?.stickerName ?? '表情')}]`;
    if (part.type === 'file') return `[文件] ${part.media?.name ?? ''}`.trim();
  }
  return '[空消息]';
}

function formatClock(iso: string, timeZone?: string): string { const d = new Date(iso); if (Number.isNaN(d.getTime())) return ''; return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false, hourCycle: 'h23', ...(timeZone ? { timeZone } : {}) }).format(d); }
function formatFullDateTime(iso: string, timeZone?: string): string { const d = new Date(iso); if (Number.isNaN(d.getTime())) return ''; return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short', ...(timeZone ? { timeZone } : {}) }).format(d); }
function formatBytes(n: number): string { return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`; }
function messageText(message: ChatMessage): string { return message.content.map((part) => part.type === 'text' ? stripModelDirectivesForDisplay(part.text) : part.type === 'audio' ? part.transcript ?? '' : '').filter(Boolean).join('\n'); }
function highlightedText(text: string, query?: string): React.ReactNode {
  const needle = query?.trim();
  if (!needle) return text;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pieces = text.split(new RegExp(`(${escaped})`, 'igu'));
  return pieces.map((piece, index) => piece.toLocaleLowerCase() === needle.toLocaleLowerCase() ? <mark key={`${piece}-${index}`}>{piece}</mark> : piece);
}
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

function ImagePart({ part, mine, onOpen }: { part: MessagePart; mine: boolean; onOpen?: (mediaId: string) => void }) {
  const [failed, setFailed] = useState(false);
  // 气泡显示缩略图；点开大图时由 ImageViewerHost 换成原图。
  const media = useAuthenticatedMedia(part.media?.url ? mediaThumbnailPath(part.media.url, BUBBLE_IMAGE_CSS_WIDTH) : part.media?.url, 'user', 'image');
  if (part.status === 'failed') return <div className="bubble bubble-note">图片没有发出去{part.error ? `：${part.error}` : ''}</div>;
  if (!part.media) return <div className="bubble bubble-note pulsing">{mine ? '图片发送中…' : '图片生成中…'}</div>;
  if (failed) return <div className="bubble bubble-note">图片加载失败</div>;
  const rawRatio = part.media.width && part.media.height ? part.media.width / part.media.height : Number.NaN;
  const ratio = Number.isFinite(rawRatio) && rawRatio > 0 ? rawRatio : 4 / 3;
  const displayWidth = Math.min(BUBBLE_IMAGE_CSS_WIDTH, Math.max(1, Math.round(320 * ratio)));
  const { url, error } = media;
  const alt = part.media.name ?? '图片';
  if (error) return <div className="bubble bubble-note">{error}</div>;
  const open = () => {
    if (!url) return;
    if (onOpen) onOpen(part.media!.id);
    else window.dispatchEvent(new CustomEvent('sooya:open-image', { detail: { id: part.media!.id } }));
  };
  return (
    <button
      className={`image-part ${part.status === 'pending' ? 'pending-media' : ''}`}
      type="button"
      onClick={open}
      disabled={!url}
      aria-busy={!url || undefined}
      aria-label={url ? '查看大图' : '图片加载中'}
      data-media-id={part.media.id}
      data-src={url ?? ''}
      data-alt={alt}
      style={{ aspectRatio: String(ratio), width: `${displayWidth}px` }}
    >
      {url
        ? <img src={url} alt={alt} loading="lazy" onError={() => setFailed(true)} />
        : <span className="image-part-placeholder" aria-hidden="true" />}
      {part.status === 'pending' && <span className="media-sending" role="status">发送中</span>}
    </button>
  );
}
function StickerPart({ part }: { part: MessagePart }) { const [failed, setFailed] = useState(false); if (!part.media || failed) return null; const name = String(part.meta?.stickerName ?? '表情'); const meaning = String(part.meta?.stickerMeaning ?? ''); return <AuthenticatedImage className="sticker-part" path={part.media.url} scope="user" alt={meaning ? `${name}：${meaning}` : name} title={meaning ? `${name}：${meaning}` : name} loading="lazy" onError={() => setFailed(true)} />; }
function FilePart({ part, mine }: { part: MessagePart; mine: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!part.media) return <div className="bubble bubble-note">{mine ? '文件发送中…' : '文件不可用'}</div>;
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
  const textStatus = part.media.textStatus;
  const textLabel = textStatus === 'ready' ? '可读取' : textStatus === 'pending' ? '正在解析' : textStatus === 'failed' ? '解析失败' : textStatus === 'unsupported' ? '仅保存' : '仅保存';
  return <>
    <button className={`bubble bubble-file ${part.status === 'pending' ? 'pending-media' : ''}`} type="button" disabled={busy} onClick={() => void save()}><span className="file-icon">▣</span><span className="file-meta"><span className="file-name">{part.media.name ?? '文件'}</span><span className="file-size">{busy ? '下载中…' : formatBytes(part.media.bytes)}</span></span><span className="file-text-status" data-testid="file-text-status">{textLabel}</span>{part.status === 'pending' && <span className="media-sending" role="status">发送中</span>}</button>
    {error && <div className="bubble bubble-note file-error" role="status">{error}</div>}
  </>;
}

interface Props {
  message: ChatMessage; personaName: string; avatar: string; userAvatar: string; showAvatar: boolean; timeZone?: string;
  highlightQuery?: string;
  /** Jump-to target: flashes the row via `.message-highlight`. `highlightNonce` bumps
   * so clicking the same message twice re-runs the animation. */
  highlighted?: boolean; highlightNonce?: number;
  /** The message being replied to, when it is still loaded. */
  quoted?: ChatMessage | null; quotedLabel?: string; quotedStatus?: 'loading' | 'ready' | 'missing' | 'error'; onQuotedClick?: (messageId: string) => void;
  /**
   * Id of the message directly above this one. Every assistant reply carries
   * `replyTo` pointing at the message that triggered it, which in a 1v1 chat is
   * almost always the line right above — rendering a quote of it just repeats what
   * the user can already see. Quoting anything further back is still shown.
   */
  previousId?: string | null;
  onRetry?: (message: ChatMessage) => void; onResend?: (message: ChatMessage) => void; onQuote?: (message: ChatMessage) => void; onWithdraw?: (message: ChatMessage) => void; onOpenImage?: (mediaId: string) => void; onNotice?: (text: string) => void;
}

/**
 * Plays a read-aloud audio attached to a text part (meta.readAloudMediaId).
 * The media ref is fetched lazily; playback uses the authenticated blob path.
 */
function ReadAloudButton({ mediaId }: { mediaId: string }) {
  const [mediaPath, setMediaPath] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.mediaMeta(mediaId).then((result) => { if (!cancelled) setMediaPath(result.media.url); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [mediaId]);
  const media = useAuthenticatedMedia(mediaPath, 'user', 'audio');
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    if (!media.url) return;
    const audio = new Audio(media.url);
    audioRef.current = audio;
    const onEnded = () => setPlaying(false);
    audio.addEventListener('ended', onEnded);
    return () => { audio.removeEventListener('ended', onEnded); audio.pause(); audioRef.current = null; };
  }, [media.url]);
  if (!mediaPath && !media.url) return null;
  return (
    <button
      type="button"
      className="read-aloud-btn"
      data-testid="read-aloud"
      disabled={!media.url}
      onClick={() => {
        const audio = audioRef.current;
        if (!audio) return;
        if (playing) { audio.pause(); setPlaying(false); } else { void audio.play().then(() => setPlaying(true)).catch(() => undefined); }
      }}
    >
      {playing ? '停止' : '朗读'}
    </button>
  );
}

/**
 * Inner-thought UI ("⌁ 她在想…"). Renders above the bubbles inside `.msg-body`,
 * so it inherits the message's max-width and is measured by the virtualizer
 * like any other content — the only size changes are user-initiated (toggle),
 * so there is no unpredictable scroll jump. Modes are stored locally
 * (lib/innerThought.ts): off / brief (collapsed chip) / immersive (expanded).
 * On mobile it expands inline; it never opens a separate "thinking window".
 */
export function InnerThoughtChip({ messageId, onNotice }: { messageId: string; onNotice?: (text: string) => void }) {
  const [mode, setMode] = useState<InnerThoughtMode>(() => getInnerThoughtMode());
  const [thought, setThought] = useState<VisibleThought | null>(null);
  const [expanded, setExpanded] = useState(false);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    if (mode !== 'off') {
      api.visibleThought(messageId, controller.signal)
        .then((body) => { if (mounted.current && body?.thought) setThought(body.thought); })
        .catch(() => { /* no thought (404), flag off, or offline: stay quiet */ });
    } else {
      setThought(null);
    }
    return () => { mounted.current = false; controller.abort(); };
  }, [messageId, mode]);

  const cycleMode = () => {
    const next = nextInnerThoughtMode(mode);
    setInnerThoughtMode(next);
    setMode(next);
    const label = INNER_THOUGHT_MODES.find((m) => m.value === next)?.label ?? next;
    onNotice?.(`内心想法模式：${label}`);
  };

  if (mode === 'off' || !thought) return null;

  const text = limitToThreeSentences(thought.text);
  const showBody = expanded || mode === 'immersive';
  const modeLabel = INNER_THOUGHT_MODES.find((m) => m.value === mode)?.label ?? mode;

  if (!showBody) {
    return (
      <div className="thought-chip-row">
        <button
          type="button"
          className="thought-chip"
          aria-expanded={false}
          data-testid="inner-thought"
          onClick={() => setExpanded(true)}
        >
          <span className="thought-prefix" aria-hidden="true">⌁</span> 她在想…
        </button>
      </div>
    );
  }

  return (
    <div className="thought-block" data-testid="inner-thought">
      <div className="thought-block-head">
        <button
          type="button"
          className="thought-chip"
          aria-expanded={true}
          onClick={() => setExpanded(false)}
        >
          <span className="thought-prefix" aria-hidden="true">⌁</span> 她在想…
        </button>
        <button type="button" className="thought-mode-btn" aria-label={`内心想法模式：${modeLabel}`} title="切换模式：关闭 / 简短 / 沉浸" onClick={cycleMode}>
          {modeLabel}
        </button>
      </div>
      <p className="thought-text">{text}</p>
    </div>
  );
}

export const MessageItem = memo(function MessageItem({ message, personaName, avatar, userAvatar, showAvatar, timeZone, highlightQuery, highlighted, highlightNonce, quoted, quotedLabel, quotedStatus, onQuotedClick, previousId, onRetry, onResend, onQuote, onWithdraw, onOpenImage, onNotice }: Props) {
  const mine = message.role === 'user';
  // Every assistant turn carries `replyTo` for stream recovery, so a preview is only
  // worth showing when it says something the bubble order does not: not the message
  // right above, and not a target that scrolled out of the loaded window — for those
  // the placeholder is pure noise. A user message is different: the quote was chosen
  // deliberately, so say the original is gone rather than dropping it silently.
  // A user-selected quote is intentional, even when the quoted message is
  // immediately above it. The assistant's structural replyTo link is the
  // case where suppressing the adjacent preview avoids repetition.
  // Auto-merged batches must not render a misleading quote card: the
  // structural replyTo is only a stream-recovery link. Only an explicitly
  // user-chosen target (replyMode === 'explicit') forces the preview.
  const replyMode = message.meta?.replyMode as string | undefined;
  // Structural replyTo (stream recovery / auto batches) shows a preview only
  // when it says something the bubble order does not — i.e. NOT the message
  // right above. A user-chosen quote (mine or replyMode 'explicit') is
  // deliberate and always shows when the target is available.
  const showReplyPreview = Boolean(message.replyTo)
    && (Boolean(quoted) || Boolean(quotedStatus) || mine)
    && (mine || replyMode === 'explicit' || previousId === null || message.replyTo !== previousId);
  const visible = message.content.filter((part) => part.type !== 'system');
  const failedMessage = message.status === 'failed';
  const replayable = isReplayableUserMessage(message);
  const retryable = isRetryableFailedMessage(message);
  const [menu, setMenu] = useState<{ x: number; y: number; selectedText: string } | null>(null);
  const [flash, setFlash] = useState(false);
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

  useEffect(() => {
    if (!highlighted) { setFlash(false); return; }
    // Toggle off→on so a repeat click on the same row re-runs the animation.
    setFlash(false);
    const raf = window.requestAnimationFrame(() => setFlash(true));
    const timer = window.setTimeout(() => setFlash(false), 1800);
    return () => { window.cancelAnimationFrame(raf); window.clearTimeout(timer); };
  }, [highlighted, highlightNonce]);

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
    <div ref={messageRef} className={`msg-row ${mine ? 'mine' : 'theirs'}${flash ? ' message-highlight' : ''}`} data-role={message.role} data-status={message.status} data-message-id={message.id} data-testid="message"
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
          <div className={`message-reply-preview ${quoted && onQuotedClick ? 'clickable' : ''}`} data-testid="reply-preview" role={quoted && onQuotedClick ? 'button' : undefined} tabIndex={quoted && onQuotedClick ? 0 : undefined} onClick={() => { if (quoted && message.replyTo) onQuotedClick?.(quoted.id); }} onKeyDown={(event) => { if (quoted && message.replyTo && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onQuotedClick?.(quoted.id); } }}>
            <span className="reply-author">{quotedLabel || '原消息'}</span>
            <span className="reply-text">{quoted ? quotedPreview(quoted) : quotedStatus === 'loading' ? '正在读取原消息…' : quotedStatus === 'error' ? '原消息暂时无法读取' : '原消息已删除或不可用'}</span>
          </div>
        )}
        {!mine && message.status === 'sent' && (
          <InnerThoughtChip messageId={message.id} onNotice={onNotice} />
        )}
        <div className="bubbles">{visible.map((part) => { switch (part.type) { case 'text': { const displayText = stripModelDirectivesForDisplay(part.text); const readAloudId = part.meta?.readAloudMediaId as string | undefined; return displayText ? <div key={part.id} className="text-bubble-block"><div className={`bubble bubble-text ${mine ? 'mine' : 'theirs'}`} data-testid="text-bubble">{highlightedText(displayText, highlightQuery)}</div>{!mine && <WebCitations meta={part.meta} />}{readAloudId && <ReadAloudButton mediaId={readAloudId} />}</div> : null; } case 'sticker': return <StickerPart key={part.id} part={part} />; case 'image': return <ImagePart key={part.id} part={part} mine={mine} onOpen={onOpenImage} />; case 'audio': return <AudioBubble key={part.id} part={part} mine={mine} />; case 'file': return <FilePart key={part.id} part={part} mine={mine} />; default: return null; } })}</div>
        <div className="msg-meta"><span className="clock" title={formatFullDateTime(message.createdAt, timeZone)}>{formatClock(message.createdAt, timeZone)}</span>{message.pendingLocal && message.status !== 'failed' && <span className="sending-dot" aria-label="发送中" />}{failedMessage && <span className="failed-flag">发送失败{retryable && onRetry && <button type="button" className="retry-btn" onClick={() => onRetry(message)}>重试</button>}</span>}<button type="button" className="message-menu-button" aria-label="消息操作" onClick={(event) => openMenu(event.clientX, event.clientY)}>···</button></div>
      </div>
      {menu && <div ref={menuRef} className="message-action-menu" role="menu" aria-label="消息操作" style={{ position: 'fixed', left: menu.x, top: menu.y, zIndex: 10000 }}>
        {text && <button role="menuitem" type="button" onClick={() => void act(() => copy(text), '已复制全文')}>复制全文</button>}
        {text && <button role="menuitem" type="button" disabled={!menu.selectedText} onClick={() => void act(() => copy(menu.selectedText), '已复制文本')}>复制选中文本</button>}
        {onQuote && <button role="menuitem" type="button" onClick={() => void act(() => onQuote(message))}>引用回复</button>}
        {replayable && !message.pendingLocal && !failedMessage && onResend && <button role="menuitem" type="button" onClick={() => void act(() => onResend(message))}>再次发送</button>}
        {retryable && onRetry && <button role="menuitem" type="button" onClick={() => void act(() => onRetry(message))}>重试</button>}
        {withdrawable && onWithdraw && <button role="menuitem" type="button" className="danger" onClick={() => void act(() => onWithdraw(message))}>撤回（保留占位）</button>}
        {image?.media && <><button role="menuitem" type="button" onClick={() => void act(() => onOpenImage?.(image.media!.id))}>查看图片</button><button role="menuitem" type="button" onClick={() => void act(() => savePart(image), '图片已保存')}>保存图片</button><button role="menuitem" type="button" onClick={() => void act(() => { window.open(`/gallery?media=${encodeURIComponent(image.media!.id)}`, '_blank', 'noopener,noreferrer'); })}>进入图库</button></>}
        {audio?.media && <><button role="menuitem" type="button" onClick={() => void act(() => savePart(audio), '语音已保存')}>保存语音</button>{audio.transcript && <button role="menuitem" type="button" onClick={() => void act(() => copy(audio.transcript!), '转写文本已复制')}>复制转写</button>}</>}
      </div>}
    </div>
  );
});
