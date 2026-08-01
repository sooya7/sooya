import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useChat } from './lib/useChat.js';
import AdminPanel from './components/AdminPanel.js';
import { NotificationBridge } from './components/NotificationBridge.js';
import { MessageItem } from './components/MessageItem.js';
import { Composer } from './components/Composer.js';
import { setToken } from './lib/api.js';
import { AVATAR_IMAGE_CSS_WIDTH, mediaThumbnailPath } from './lib/authenticatedMedia.js';
import { useAuthenticatedMedia } from './lib/useAuthenticatedMedia.js';
import type { ChatMessage } from './lib/types.js';
import type { ServiceWorkerUpdateController } from './lib/serviceWorkerUpdate.js';
import { shouldStartDateSeparator, shouldStartMessageGroup, userTimeZone } from './lib/messageGrouping.js';
import { DateSeparator } from './components/DateSeparator.js';
import { api, type MessageSearchHit } from './lib/api.js';

const NEAR_BOTTOM_PX = 120;
const MESSAGE_DOM_LIMIT = 800;
export default function App() { return window.location.pathname === '/admin' || window.location.pathname === '/admin/' ? <AdminPanel /> : <ChatApp />; }

/** Who the quoted message belongs to, for the reply row above a bubble. */
function quotedLabel(message: ChatMessage | null, personaName: string): string {
  if (!message) return '原消息';
  return message.role === 'user' ? '我' : personaName;
}

function preview(message: ChatMessage): string {
  const text = message.content.map((part) => part.type === 'text' ? part.text ?? '' : part.type === 'audio' ? part.transcript ?? '' : '').filter(Boolean).join(' ');
  return text.slice(0, 90) || (message.content.some((part) => part.type === 'image') ? '[图片]' : message.content.some((part) => part.type === 'audio') ? '[语音]' : '[消息]');
}

function ChatApp() {
  const chat = useChat();
  // 头像只显示几十像素，不需要原图。
  const personaAvatar = useAuthenticatedMedia(chat.persona?.avatar ? mediaThumbnailPath(chat.persona.avatar, AVATAR_IMAGE_CSS_WIDTH) : chat.persona?.avatar, 'user', 'image');
  const userAvatar = useAuthenticatedMedia(chat.persona?.userAvatar ? mediaThumbnailPath(chat.persona.userAvatar, AVATAR_IMAGE_CSS_WIDTH) : chat.persona?.userAvatar, 'user', 'image');
  const scrollerRef = useRef<HTMLDivElement | null>(null); const bottomRef = useRef<HTMLDivElement | null>(null); const sentinelRef = useRef<HTMLDivElement | null>(null); const messagesRef = useRef<HTMLDivElement | null>(null);
  const [stickToBottom, setStickToBottom] = useState(true); const [unread, setUnread] = useState(0); const [notice, setNotice] = useState<string | null>(null); const [tokenInput, setTokenInput] = useState(''); const [quote, setQuote] = useState<ChatMessage | null>(null); const [swUpdate, setSwUpdate] = useState<ServiceWorkerUpdateController | null>(null); const [historyOpen, setHistoryOpen] = useState(false); const [searchQuery, setSearchQuery] = useState(''); const [searchHits, setSearchHits] = useState<MessageSearchHit[]>([]); const [searchIndex, setSearchIndex] = useState(0); const [historyBusy, setHistoryBusy] = useState(false); const [historyError, setHistoryError] = useState<string | null>(null); const [dateQuery, setDateQuery] = useState(''); const [windowAnchorId, setWindowAnchorId] = useState<string | null>(null);
  const stickToBottomRef = useRef(true); const prevCountRef = useRef(0); const prevHeightRef = useRef(0); const prevLastIdRef = useRef<string | null>(null); const loadingOlderRef = useRef(false); const didInitialScrollRef = useRef(false);
  const historyScrollTopRef = useRef(0);

  const handleScroll = useCallback(() => { const el = scrollerRef.current; if (!el) return; const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX; stickToBottomRef.current = atBottom; setStickToBottom(atBottom); if (atBottom) setUnread(0); }, []);
  useLayoutEffect(() => {
    const el = scrollerRef.current; if (!el) return; const messages = chat.messages; const count = messages.length; const lastId = messages[count - 1]?.id ?? null;
    if (!didInitialScrollRef.current && count > 0) { didInitialScrollRef.current = true; prevCountRef.current = count; prevHeightRef.current = el.scrollHeight; prevLastIdRef.current = lastId; el.scrollTop = el.scrollHeight; return; }
    const appended = countAppended(messages, prevLastIdRef.current);
    if (loadingOlderRef.current) { const delta = el.scrollHeight - prevHeightRef.current; if (delta > 0) el.scrollTop += delta; loadingOlderRef.current = false; }
    else if (stickToBottomRef.current) bottomRef.current?.scrollIntoView({ block: 'end' });
    if (appended > 0 && !stickToBottomRef.current) setUnread((value) => value + appended);
    prevCountRef.current = count; prevHeightRef.current = el.scrollHeight; prevLastIdRef.current = lastId;
  }, [chat.messages]);

  useEffect(() => { const scroller = scrollerRef.current; const content = messagesRef.current; if (!scroller || !content || typeof ResizeObserver === 'undefined') return; const observer = new ResizeObserver(() => { if (!loadingOlderRef.current && stickToBottomRef.current) scroller.scrollTop = scroller.scrollHeight; }); observer.observe(content); return () => observer.disconnect(); }, []);
  useEffect(() => { const sentinel = sentinelRef.current; const scroller = scrollerRef.current; if (!sentinel || !scroller) return; const observer = new IntersectionObserver((entries) => { if (entries[0]?.isIntersecting && chat.hasMore && !chat.loadingOlder) { loadingOlderRef.current = true; prevHeightRef.current = scroller.scrollHeight; void chat.loadOlder(); } }, { root: scroller, rootMargin: '120px 0px 0px 0px' }); observer.observe(sentinel); return () => observer.disconnect(); }, [chat.hasMore, chat.loadOlder, chat.loadingOlder]);
  useEffect(() => {
    // main.tsx registers the worker and forwards a waiting update here.
    const onReady = (event: Event) => setSwUpdate((event as CustomEvent<ServiceWorkerUpdateController>).detail);
    window.addEventListener('sooya:sw-update-ready', onReady);
    return () => window.removeEventListener('sooya:sw-update-ready', onReady);
  }, []);
  useEffect(() => { if (!chat.error) return; setNotice(chat.error); const timer = window.setTimeout(() => { setNotice(null); chat.clearError(); }, 5000); return () => clearTimeout(timer); }, [chat.error]);
  useEffect(() => {
    const ids = new Set(chat.messages.map((message) => message.replyTo).filter((id): id is string => Boolean(id)));
    for (const id of ids) {
      if (!chat.messages.some((message) => message.id === id) && !chat.quotedStates[id]) void chat.ensureQuotedMessage(id);
    }
  }, [chat.ensureQuotedMessage, chat.messages, chat.quotedStates]);
  useEffect(() => {
    const mediaError = personaAvatar.error ?? userAvatar.error;
    if (!mediaError) return;
    setNotice(mediaError);
    const timer = window.setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [personaAvatar.error, userAvatar.error]);

  const jumpToBottom = () => { stickToBottomRef.current = true; setStickToBottom(true); setUnread(0); bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); };
  const jumpToMessage = async (id: string) => {
    const target = chat.messages.find((message) => message.id === id) ?? await chat.ensureQuotedMessage(id);
    if (!target) { setNotice('原消息已删除或不可用'); return; }
    setWindowAnchorId(id);
    window.setTimeout(() => {
      const node = Array.from(document.querySelectorAll<HTMLElement>('[data-message-id]')).find((item) => item.dataset.messageId === id);
      if (!node) return;
      node.scrollIntoView({ behavior: 'smooth', block: 'center' });
      node.classList.add('message-highlight');
      window.setTimeout(() => node.classList.remove('message-highlight'), 1800);
    }, 0);
  };
  const jumpToSearchHit = async (hit: MessageSearchHit) => {
    setWindowAnchorId(hit.message.id);
    chat.addMessages([hit.message]);
    await chat.ensureQuotedMessage(hit.message.id);
    window.setTimeout(() => {
      const node = Array.from(document.querySelectorAll<HTMLElement>('[data-message-id]')).find((item) => item.dataset.messageId === hit.message.id);
      if (!node) return;
      node.scrollIntoView({ behavior: 'smooth', block: 'center' });
      node.classList.add('message-highlight');
      window.setTimeout(() => node.classList.remove('message-highlight'), 1800);
    }, 0);
  };
  const runSearch = async () => {
    if (!searchQuery.trim()) return;
    setHistoryBusy(true); setHistoryError(null);
    try {
      const result = await api.messageSearch(searchQuery, { limit: 30 });
      setSearchHits(result.hits); setSearchIndex(0);
      if (result.hits[0]) await jumpToSearchHit(result.hits[0]);
    } catch (error) { setHistoryError(error instanceof Error ? error.message : '搜索失败'); }
    finally { setHistoryBusy(false); }
  };
  const jumpSearch = async (index: number) => {
    const normalized = (index + searchHits.length) % searchHits.length;
    const hit = searchHits[normalized];
    if (!hit) return;
    setSearchIndex(normalized);
    await jumpToSearchHit(hit);
  };
  const runDateJump = async () => {
    if (!dateQuery) return;
    setHistoryBusy(true); setHistoryError(null);
    try {
      const result = await api.messagesByDate(dateQuery, userTimeZone());
      chat.addMessages(result.messages);
      if (result.messages[0]) await jumpToSearchHit({ message: result.messages[0], snippet: '', matchedPartId: null });
    } catch (error) { setHistoryError(error instanceof Error ? error.message : '日期跳转失败'); }
    finally { setHistoryBusy(false); }
  };
  const clearHistoryTools = () => { setSearchHits([]); setSearchIndex(0); setSearchQuery(''); setHistoryError(null); setHistoryOpen(false); window.setTimeout(() => { if (scrollerRef.current) scrollerRef.current.scrollTop = historyScrollTopRef.current; }, 0); };
  const restoreQuote = useCallback(async (id: string) => {
    const message = chat.messages.find((item) => item.id === id) ?? await chat.ensureQuotedMessage(id);
    if (message) setQuote(message);
  }, [chat.ensureQuotedMessage, chat.messages]);
  const action = async (work: () => Promise<unknown>, success?: string) => { try { await work(); if (success) setNotice(success); } catch (error) { setNotice((error as Error).message); } };
  const statusLabel = chat.connection === 'online' ? chat.activity.thinking ? chat.activity.label ?? '正在输入' : '在线' : chat.connection === 'connecting' ? '连接中…' : chat.connection === 'unauthorized' ? '需要访问令牌' : '连接已断开，正在重试';
  const renderedMessages = useMemo(() => {
    if (chat.messages.length <= MESSAGE_DOM_LIMIT) return chat.messages;
    const anchor = windowAnchorId ? chat.messages.findIndex((message) => message.id === windowAnchorId) : -1;
    if (anchor >= 0) return chat.messages.slice(Math.max(0, anchor - MESSAGE_DOM_LIMIT / 2), anchor + MESSAGE_DOM_LIMIT / 2);
    return chat.messages.slice(-MESSAGE_DOM_LIMIT);
  }, [chat.messages, windowAnchorId]);

  if (chat.connection === 'unauthorized') return <div className="gate"><div className="gate-card"><h1>SOOYA</h1><p>这台服务器需要访问令牌。</p><input type="password" value={tokenInput} placeholder="WEB_CHAT_TOKEN" onChange={(e) => setTokenInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && tokenInput.trim()) { setToken(tokenInput.trim()); location.reload(); } }} /><button type="button" onClick={() => { if (tokenInput.trim()) { setToken(tokenInput.trim()); location.reload(); } }}>进入</button></div></div>;

  const persona = chat.persona ? { ...chat.persona, avatar: personaAvatar.url ?? '/avatars/sooya.svg', userAvatar: userAvatar.url ?? '/avatars/user.svg' } : null; const timeZone = userTimeZone(); let previousMessage: ChatMessage | null = null;
  const composerDisabled = !chat.ready || chat.connection !== 'online';
  const composerDisabledLabel = !chat.ready ? '正在打开你们的聊天……' : chat.connection !== 'online' ? '网络已断开' : undefined;
  return <div className="app">
    <header className="topbar"><div className="topbar-identity"><img className="topbar-avatar" src={persona?.avatar ?? '/avatars/sooya.svg'} alt="" /><div className="topbar-text"><span className="topbar-name">{persona?.name ?? 'SOOYA'}</span><span className={`topbar-status ${chat.connection}`} data-testid="connection-status"><span className="status-dot" />{statusLabel}</span>{chat.connection === 'online' && chat.life && <span className="topbar-life" data-testid="life-activity" title={`心情${chat.life.mood}`}>{chat.life.activity}</span>}</div></div><NotificationBridge /><button type="button" className="history-tool-button" aria-label="搜索和日期跳转" onClick={() => { historyScrollTopRef.current = scrollerRef.current?.scrollTop ?? 0; setHistoryOpen((value) => !value); }} data-testid="history-tools">⌕</button><a className="topbar-admin-entry" href="/admin/features" aria-label="进入功能管理中心" data-testid="admin-entry"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" data-testid="admin-entry-icon" data-icon-style="six-tooth"><circle cx="12" cy="12" r="3.35" /><path d="M12 2.8v2.1" /><path d="m19.97 7.4-1.82 1.05" /><path d="m19.97 16.6-1.82-1.05" /><path d="M12 21.2v-2.1" /><path d="m4.03 16.6 1.82 1.05" /><path d="m19.97 7.4 1.82 1.05" /></svg></a></header>
    {historyOpen && <section className="history-tools" aria-label="聊天历史工具" data-testid="history-tools-panel"><form onSubmit={(event) => { event.preventDefault(); void runSearch(); }}><input aria-label="搜索消息" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="搜索聊天内容" /><button type="submit" disabled={historyBusy}>搜索</button></form><div className="history-date-row"><input type="date" aria-label="按日期跳转" value={dateQuery} onChange={(event) => setDateQuery(event.target.value)} /><button type="button" disabled={historyBusy || !dateQuery} onClick={() => void runDateJump()}>跳转</button></div>{searchHits.length > 0 && <div className="history-results"><span>找到 {searchHits.length} 条 · {searchIndex + 1}/{searchHits.length}</span><button type="button" onClick={() => void jumpSearch(searchIndex - 1)}>上一个</button><button type="button" onClick={() => void jumpSearch(searchIndex + 1)}>下一个</button><span className="history-snippet">{searchHits[searchIndex]?.snippet}</span></div>}{historyError && <div className="history-error" role="alert">{historyError}</div>}<button type="button" className="history-clear" onClick={clearHistoryTools}>清除并返回原位置</button></section>}
    <div className="scroller" ref={scrollerRef} onScroll={handleScroll} data-testid="scroller"><div ref={sentinelRef} className="load-sentinel" />{!chat.ready && <BootstrapSkeleton />}{chat.ready && chat.connection === 'offline' && chat.messages.length === 0 && chat.error && <div className="bootstrap-error" role="alert"><strong>聊天暂时无法打开</strong><span>{chat.error}</span><button type="button" onClick={() => void chat.reload()}>重新连接</button></div>}{chat.loadingOlder && <div className="history-hint">正在加载更早的消息…</div>}{!chat.hasMore && chat.ready && chat.messages.length > 0 && <div className="history-hint muted">这是你们聊天的开始</div>}{chat.ready && chat.messages.length === 0 && chat.connection !== 'offline' && <div className="empty-state"><img src={persona?.avatar ?? '/avatars/sooya.svg'} alt="" /><p>和 {persona?.name ?? 'SOOYA'} 说点什么吧</p></div>}
      <div className="messages" ref={messagesRef}>{renderedMessages.map((message, index) => { const showAvatar = shouldStartMessageGroup(previousMessage, message, timeZone); const showDate = shouldStartDateSeparator(previousMessage, message, timeZone); previousMessage = message; const quoted = message.replyTo ? chat.messages.find((m) => m.id === message.replyTo) ?? chat.quotedStates[message.replyTo]?.message ?? null : null; const quotedStatus = message.replyTo ? chat.quotedStates[message.replyTo]?.status : undefined; return <Fragment key={message.id}>{showDate && <DateSeparator iso={message.createdAt} timeZone={timeZone} />}<MessageItem message={message} previousId={renderedMessages[index - 1]?.id ?? null} highlightQuery={searchQuery} quoted={quoted} quotedStatus={quotedStatus} onQuotedClick={jumpToMessage} quotedLabel={message.replyTo ? quotedLabel(quoted, persona?.name ?? 'SOOYA') : ''} personaName={persona?.name ?? 'SOOYA'} avatar={persona?.avatar ?? '/avatars/sooya.svg'} userAvatar={persona?.userAvatar ?? '/avatars/user.svg'} showAvatar={showAvatar} timeZone={timeZone} onRetry={(m) => void action(() => { setNotice('正在重试'); return chat.retryFailed(m); })} onResend={(m) => void action(() => chat.sendAgain(m), '已再次发送')} onQuote={setQuote} onWithdraw={(m) => void action(() => chat.withdraw(m), '消息已撤回并保留上下文占位')} onNotice={setNotice} onOpenImage={(id) => window.dispatchEvent(new CustomEvent('sooya:open-image', { detail: { id } }))} /></Fragment>; })}{chat.activity.thinking && !hasStreamingBubble(chat.messages) && <div className="msg-row theirs" data-testid="typing-indicator"><div className="avatar-slot"><img className="avatar" src={persona?.avatar ?? '/avatars/sooya.svg'} alt="" /></div><div className="msg-body"><div className="bubble bubble-text theirs typing"><span className="typing-dots"><i /><i /><i /></span></div></div></div>}</div><div ref={bottomRef} className="bottom-anchor" /></div>
    {unread > 0 && !stickToBottom && <button type="button" className="unread-pill" data-testid="unread-pill" onClick={jumpToBottom}>{unread} 条新消息 ↓</button>}
    {swUpdate && <div className="sw-update" role="status" data-testid="sw-update"><span>有新版本可用</span><button type="button" className="sw-update-accept" onClick={() => { swUpdate.accept(); setSwUpdate(null); }}>立即更新</button><button type="button" className="sw-update-later" onClick={() => { swUpdate.dismiss(); setSwUpdate(null); }}>稍后</button></div>}
    {notice && <div className="toast" role="status"><span>{notice}</span><button type="button" className="toast-close" aria-label="关闭提示" onClick={() => setNotice(null)}>×</button></div>}
    {quote && <div className="composer-quote"><div><strong>引用{quote.role === 'user' ? '我的' : persona?.name ?? 'SOOYA'}消息</strong><span>{preview(quote)}</span></div><button type="button" aria-label="取消引用" onClick={() => setQuote(null)}>×</button></div>}
    <Composer key="chat-composer" conversationId="main" replyToId={quote?.id ?? null} onRestoreReplyTo={(id) => { void restoreQuote(id); }} disabled={composerDisabled} disabledLabel={composerDisabledLabel} stickers={chat.stickers} onSend={async (payload) => { const result = await chat.send(payload.content, payload.optimisticParts, quote?.id); setQuote(null); return result; }} onNotice={setNotice} />
  </div>;
}

function BootstrapSkeleton() {
  return <section className="bootstrap-loading" aria-busy="true" data-testid="bootstrap-loading"><div className="bootstrap-title"><span className="avatar-skeleton" /><span>正在打开你们的聊天……<span className="typing-dots"><i /><i /><i /></span></span></div><div className="message-skeleton theirs"><span /><span /></div><div className="message-skeleton mine"><span /></div><div className="message-skeleton theirs"><span /><span /><span /></div></section>;
}

function countAppended(messages: ChatMessage[], prevLastId: string | null): number { if (!messages.length) return 0; if (!prevLastId) return messages.length; const index = messages.findIndex((message) => message.id === prevLastId); return index < 0 ? 0 : messages.length - 1 - index; }
function hasStreamingBubble(messages: ChatMessage[]): boolean { const last = messages[messages.length - 1]; return !!last && last.role === 'assistant' && last.status === 'sending'; }
