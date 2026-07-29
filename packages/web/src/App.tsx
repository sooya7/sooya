import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useChat } from './lib/useChat.js';
import AdminPanel from './components/AdminPanel.js';
import { MessageItem } from './components/MessageItem.js';
import { Composer } from './components/Composer.js';
import { setToken } from './lib/api.js';
import { useAuthenticatedMedia } from './lib/useAuthenticatedMedia.js';
import type { ChatMessage } from './lib/types.js';

const NEAR_BOTTOM_PX = 120;
export default function App() { return window.location.pathname === '/admin' || window.location.pathname === '/admin/' ? <AdminPanel /> : <ChatApp />; }

function preview(message: ChatMessage): string {
  const text = message.content.map((part) => part.type === 'text' ? part.text ?? '' : part.type === 'audio' ? part.transcript ?? '' : '').filter(Boolean).join(' ');
  return text.slice(0, 90) || (message.content.some((part) => part.type === 'image') ? '[图片]' : message.content.some((part) => part.type === 'audio') ? '[语音]' : '[消息]');
}

function ChatApp() {
  const chat = useChat();
  const personaAvatar = useAuthenticatedMedia(chat.persona?.avatar, 'user', 'image');
  const userAvatar = useAuthenticatedMedia(chat.persona?.userAvatar, 'user', 'image');
  const scrollerRef = useRef<HTMLDivElement | null>(null); const bottomRef = useRef<HTMLDivElement | null>(null); const sentinelRef = useRef<HTMLDivElement | null>(null); const messagesRef = useRef<HTMLDivElement | null>(null);
  const [stickToBottom, setStickToBottom] = useState(true); const [unread, setUnread] = useState(0); const [notice, setNotice] = useState<string | null>(null); const [tokenInput, setTokenInput] = useState(''); const [quote, setQuote] = useState<ChatMessage | null>(null);
  const stickToBottomRef = useRef(true); const prevCountRef = useRef(0); const prevHeightRef = useRef(0); const prevLastIdRef = useRef<string | null>(null); const loadingOlderRef = useRef(false); const didInitialScrollRef = useRef(false);

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
  useEffect(() => { if (!chat.error) return; setNotice(chat.error); const timer = window.setTimeout(() => { setNotice(null); chat.clearError(); }, 5000); return () => clearTimeout(timer); }, [chat.error]);
  useEffect(() => {
    const mediaError = personaAvatar.error ?? userAvatar.error;
    if (mediaError) setNotice(mediaError);
  }, [personaAvatar.error, userAvatar.error]);

  const jumpToBottom = () => { stickToBottomRef.current = true; setStickToBottom(true); setUnread(0); bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); };
  const action = async (work: () => Promise<unknown>, success?: string) => { try { await work(); if (success) setNotice(success); } catch (error) { setNotice((error as Error).message); } };
  const statusLabel = chat.connection === 'online' ? chat.activity.thinking ? chat.activity.label ?? '正在输入' : '在线' : chat.connection === 'connecting' ? '连接中…' : chat.connection === 'unauthorized' ? '需要访问令牌' : '连接已断开，正在重试';

  if (chat.connection === 'unauthorized') return <div className="gate"><div className="gate-card"><h1>SOOYA</h1><p>这台服务器需要访问令牌。</p><input type="password" value={tokenInput} placeholder="WEB_CHAT_TOKEN" onChange={(e) => setTokenInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && tokenInput.trim()) { setToken(tokenInput.trim()); location.reload(); } }} /><button type="button" onClick={() => { if (tokenInput.trim()) { setToken(tokenInput.trim()); location.reload(); } }}>进入</button></div></div>;

  const persona = chat.persona ? { ...chat.persona, avatar: personaAvatar.url ?? '/avatars/sooya.svg', userAvatar: userAvatar.url ?? '/avatars/user.svg' } : null; let lastRole: string | null = null;
  return <div className="app">
    <header className="topbar"><div className="topbar-identity"><img className="topbar-avatar" src={persona?.avatar ?? '/avatars/sooya.svg'} alt="" /><div className="topbar-text"><span className="topbar-name">{persona?.name ?? 'SOOYA'}</span><span className={`topbar-status ${chat.connection}`} data-testid="connection-status"><span className="status-dot" />{statusLabel}</span></div></div><a className="topbar-admin-entry" href="/admin/features" aria-label="进入功能管理中心" data-testid="admin-entry"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" data-testid="admin-entry-icon" data-icon-style="six-tooth"><circle cx="12" cy="12" r="3.35" /><path d="M12 2.8v2.1" /><path d="m19.97 7.4-1.82 1.05" /><path d="m19.97 16.6-1.82-1.05" /><path d="M12 21.2v-2.1" /><path d="m4.03 16.6 1.82-1.05" /><path d="m4.03 7.4 1.82 1.05" /></svg></a></header>
    <div className="scroller" ref={scrollerRef} onScroll={handleScroll} data-testid="scroller"><div ref={sentinelRef} className="load-sentinel" />{chat.loadingOlder && <div className="history-hint">正在加载更早的消息…</div>}{!chat.hasMore && chat.ready && chat.messages.length > 0 && <div className="history-hint muted">这是你们聊天的开始</div>}{chat.ready && chat.messages.length === 0 && <div className="empty-state"><img src={persona?.avatar ?? '/avatars/sooya.svg'} alt="" /><p>和 {persona?.name ?? 'SOOYA'} 说点什么吧</p></div>}
      <div className="messages" ref={messagesRef}>{chat.messages.map((message) => { const showAvatar = message.role !== lastRole; lastRole = message.role; return <MessageItem key={message.id} message={message} personaName={persona?.name ?? 'SOOYA'} avatar={persona?.avatar ?? '/avatars/sooya.svg'} userAvatar={persona?.userAvatar ?? '/avatars/user.svg'} showAvatar={showAvatar} onRetry={(m) => void action(() => chat.resend(m), '已重新发送')} onResend={(m) => void action(() => chat.resend(m), '已重新发送')} onQuote={setQuote} onWithdraw={(m) => void action(() => chat.withdraw(m), '消息已撤回并保留上下文占位')} onNotice={setNotice} onOpenImage={(id) => window.dispatchEvent(new CustomEvent('sooya:open-image', { detail: { id } }))} />; })}{chat.activity.thinking && !hasStreamingBubble(chat.messages) && <div className="msg-row theirs" data-testid="typing-indicator"><div className="avatar-slot"><img className="avatar" src={persona?.avatar ?? '/avatars/sooya.svg'} alt="" /></div><div className="msg-body"><div className="bubble bubble-text theirs typing"><span className="typing-dots"><i /><i /><i /></span></div></div></div>}</div><div ref={bottomRef} className="bottom-anchor" /></div>
    {unread > 0 && !stickToBottom && <button type="button" className="unread-pill" data-testid="unread-pill" onClick={jumpToBottom}>{unread} 条新消息 ↓</button>}
    {notice && <div className="toast">{notice}</div>}
    {quote && <div className="composer-quote"><div><strong>引用{quote.role === 'user' ? '我的' : persona?.name ?? 'SOOYA'}消息</strong><span>{preview(quote)}</span></div><button type="button" aria-label="取消引用" onClick={() => setQuote(null)}>×</button></div>}
    <Composer key="chat-composer" disabled={chat.connection === 'connecting' && !chat.ready} onSend={async (content) => { const result = await chat.send(content, undefined, quote?.id); setQuote(null); return result; }} onNotice={setNotice} />
  </div>;
}

function countAppended(messages: ChatMessage[], prevLastId: string | null): number { if (!messages.length) return 0; if (!prevLastId) return messages.length; const index = messages.findIndex((message) => message.id === prevLastId); return index < 0 ? 0 : messages.length - 1 - index; }
function hasStreamingBubble(messages: ChatMessage[]): boolean { const last = messages[messages.length - 1]; return !!last && last.role === 'assistant' && last.status === 'sending'; }
