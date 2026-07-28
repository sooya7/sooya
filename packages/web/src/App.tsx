import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useChat } from './lib/useChat.js';
import AdminPanel from './components/AdminPanel.js';
import { MessageItem } from './components/MessageItem.js';
import { Composer } from './components/Composer.js';
import { setToken } from './lib/api.js';
import type { ChatMessage } from './lib/types.js';

const NEAR_BOTTOM_PX = 120;

export default function App() {
  return window.location.pathname === '/admin' || window.location.pathname === '/admin/' ? <AdminPanel /> : <ChatApp />;
}

function ChatApp() {
  const chat = useChat();
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);

  const [stickToBottom, setStickToBottom] = useState(true);
  const [unread, setUnread] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [tokenInput, setTokenInput] = useState('');

  // Mirrored in refs so observers and layout effects always read fresh values.
  const stickToBottomRef = useRef(true);
  const prevCountRef = useRef(0);
  const prevHeightRef = useRef(0);
  const prevLastIdRef = useRef<string | null>(null);
  const loadingOlderRef = useRef(false);
  const didInitialScrollRef = useRef(false);

  /** Track whether the user is reading history; never yank them to the bottom. */
  const handleScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distance <= NEAR_BOTTOM_PX;
    stickToBottomRef.current = atBottom;
    setStickToBottom(atBottom);
    if (atBottom) setUnread(0);
  }, []);

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const messages = chat.messages;
    const count = messages.length;
    const lastId = messages[count - 1]?.id ?? null;

    // First paint always lands on the newest message.
    if (!didInitialScrollRef.current && count > 0) {
      didInitialScrollRef.current = true;
      prevCountRef.current = count;
      prevHeightRef.current = el.scrollHeight;
      prevLastIdRef.current = lastId;
      el.scrollTop = el.scrollHeight;
      return;
    }

    const appended = countAppended(messages, prevLastIdRef.current);
    const prepending = loadingOlderRef.current;

    if (prepending) {
      // Older messages were inserted above: hold the reading position.
      const delta = el.scrollHeight - prevHeightRef.current;
      if (delta > 0) el.scrollTop += delta;
      loadingOlderRef.current = false;
    } else if (stickToBottomRef.current) {
      // Covers both new messages and a growing streaming bubble.
      bottomRef.current?.scrollIntoView({ block: 'end' });
    }

    // Unread accounting is independent of prepending, so a message that arrives
    // while history is loading is still announced.
    if (appended > 0 && !stickToBottomRef.current) {
      setUnread((u) => u + appended);
    }

    prevCountRef.current = count;
    prevHeightRef.current = el.scrollHeight;
    prevLastIdRef.current = lastId;
  }, [chat.messages]);

  /**
   * Images, stickers and audio metadata arrive after layout and grow the
   * content; without this the view would drift away from the newest message.
   */
  useEffect(() => {
    const scroller = scrollerRef.current;
    const content = messagesRef.current;
    if (!scroller || !content || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (loadingOlderRef.current || !stickToBottomRef.current) return;
      scroller.scrollTop = scroller.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  // Infinite upward loading.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const scroller = scrollerRef.current;
    if (!sentinel || !scroller) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && chat.hasMore && !chat.loadingOlder) {
          loadingOlderRef.current = true;
          prevHeightRef.current = scroller.scrollHeight;
          void chat.loadOlder();
        }
      },
      { root: scroller, rootMargin: '120px 0px 0px 0px' }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [chat, chat.hasMore, chat.loadingOlder]);

  useEffect(() => {
    if (!chat.error) return;
    setNotice(chat.error);
    const t = window.setTimeout(() => {
      setNotice(null);
      chat.clearError();
    }, 5000);
    return () => window.clearTimeout(t);
  }, [chat, chat.error]);

  const jumpToBottom = () => {
    stickToBottomRef.current = true;
    setStickToBottom(true);
    setUnread(0);
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  };

  const statusLabel =
    chat.connection === 'online'
      ? chat.activity.thinking
        ? (chat.activity.label ?? '正在输入')
        : '在线'
      : chat.connection === 'connecting'
        ? '连接中…'
        : chat.connection === 'unauthorized'
          ? '需要访问令牌'
          : '连接已断开，正在重试';

  if (chat.connection === 'unauthorized') {
    return (
      <div className="gate">
        <div className="gate-card">
          <h1>SOOYA</h1>
          <p>这台服务器需要访问令牌。</p>
          <input
            type="password"
            value={tokenInput}
            placeholder="WEB_CHAT_TOKEN"
            onChange={(e) => setTokenInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && tokenInput.trim()) {
                setToken(tokenInput.trim());
                window.location.reload();
              }
            }}
          />
          <button
            type="button"
            onClick={() => {
              if (!tokenInput.trim()) return;
              setToken(tokenInput.trim());
              window.location.reload();
            }}
          >
            进入
          </button>
        </div>
      </div>
    );
  }

  const persona = chat.persona;
  let lastRole: string | null = null;

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-identity">
          <img className="topbar-avatar" src={persona?.avatar ?? '/avatars/sooya.svg'} alt="" />
          <div className="topbar-text">
            <span className="topbar-name">{persona?.name ?? 'SOOYA'}</span>
            <span className={`topbar-status ${chat.connection}`} data-testid="connection-status">
              <span className="status-dot" />
              {statusLabel}
            </span>
          </div>
        </div>
        <a className="topbar-admin-entry" href="/admin" aria-label="进入管理面板" data-testid="admin-entry">
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" data-testid="admin-entry-icon" data-icon-style="six-tooth">
            <circle cx="12" cy="12" r="3.35" />
            <path d="M12 2.8v2.1" />
            <path d="m19.97 7.4-1.82 1.05" />
            <path d="m19.97 16.6-1.82-1.05" />
            <path d="M12 21.2v-2.1" />
            <path d="m4.03 16.6 1.82-1.05" />
            <path d="m4.03 7.4 1.82 1.05" />
          </svg>
        </a>
      </header>

      <div className="scroller" ref={scrollerRef} onScroll={handleScroll} data-testid="scroller">
        <div ref={sentinelRef} className="load-sentinel" />
        {chat.loadingOlder && <div className="history-hint">正在加载更早的消息…</div>}
        {!chat.hasMore && chat.ready && chat.messages.length > 0 && (
          <div className="history-hint muted">这是你们聊天的开始</div>
        )}
        {chat.ready && chat.messages.length === 0 && (
          <div className="empty-state">
            <img src={persona?.avatar ?? '/avatars/sooya.svg'} alt="" />
            <p>和 {persona?.name ?? 'SOOYA'} 说点什么吧</p>
          </div>
        )}

        <div className="messages" ref={messagesRef}>
          {chat.messages.map((m) => {
            const showAvatar = m.role !== lastRole;
            lastRole = m.role;
            return (
              <MessageItem
                key={m.id}
                message={m}
                personaName={persona?.name ?? 'SOOYA'}
                avatar={persona?.avatar ?? '/avatars/sooya.svg'}
                userAvatar={persona?.userAvatar ?? '/avatars/user.svg'}
                showAvatar={showAvatar}
              />
            );
          })}
          {chat.activity.thinking && !hasStreamingBubble(chat.messages) && (
            <div className="msg-row theirs" data-testid="typing-indicator">
              <div className="avatar-slot">
                <img className="avatar" src={persona?.avatar ?? '/avatars/sooya.svg'} alt="" />
              </div>
              <div className="msg-body">
                <div className="bubble bubble-text theirs typing">
                  <span className="typing-dots">
                    <i />
                    <i />
                    <i />
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>
        <div ref={bottomRef} className="bottom-anchor" />
      </div>

      {unread > 0 && !stickToBottom && (
        <button type="button" className="unread-pill" onClick={jumpToBottom} data-testid="unread-pill">
          {unread} 条新消息 ↓
        </button>
      )}

      {notice && <div className="toast">{notice}</div>}

      <Composer
        disabled={chat.connection === 'connecting' && !chat.ready}
        onSend={(content) => chat.send(content)}
        onNotice={(t) => setNotice(t)}
      />
    </div>
  );
}

/** Number of messages appended after the previously-last message. */
function countAppended(messages: ChatMessage[], prevLastId: string | null): number {
  if (messages.length === 0) return 0;
  if (!prevLastId) return messages.length;
  const idx = messages.findIndex((m) => m.id === prevLastId);
  if (idx < 0) return 0;
  return messages.length - 1 - idx;
}

function hasStreamingBubble(messages: ChatMessage[]): boolean {
  const last = messages[messages.length - 1];
  return !!last && last.role === 'assistant' && last.status === 'sending';
}
