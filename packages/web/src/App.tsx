import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useChat } from './lib/useChat.js';
import { anchorScrollCorrection, captureChatViewState, INITIAL_CHAT_VIEW_STATE, type ChatScrollAnchor, type ChatViewState } from './lib/chatViewState.js';
import { ChatHeader } from './components/ChatHeader.js';
import { MessageItem } from './components/MessageItem.js';
import { Composer } from './components/Composer.js';
import { setToken } from './lib/api.js';
import { AVATAR_IMAGE_CSS_WIDTH, mediaThumbnailPath } from './lib/authenticatedMedia.js';
import { useAuthenticatedMedia } from './lib/useAuthenticatedMedia.js';
import type { ChatMessage } from './lib/types.js';
import type { ServiceWorkerUpdateController } from './lib/serviceWorkerUpdate.js';
import { shouldStartDateSeparator, shouldStartMessageGroup, userTimeZone } from './lib/messageGrouping.js';
import { estimateMessageHeight } from './lib/estimateMessageHeight.js';
import { DateSeparator } from './components/DateSeparator.js';
import { api, type MessageSearchHit } from './lib/api.js';

const NEAR_BOTTOM_PX = 120;
export type ChatController = ReturnType<typeof useChat>;
export type ChatViewStateRef = { current: ChatViewState };

export default function ChatSessionHost({ active = true }: { active?: boolean }) {
  const chat = useChat();
  const viewStateRef = useRef<ChatViewState>({ ...INITIAL_CHAT_VIEW_STATE });
  return active ? <ChatView chat={chat} viewStateRef={viewStateRef} /> : null;
}

/** Who the quoted message belongs to, for the reply row above a bubble. */
function quotedLabel(message: ChatMessage | null, personaName: string): string {
  if (!message) return '原消息';
  return message.role === 'user' ? '我' : personaName;
}

function preview(message: ChatMessage): string {
  const text = message.content.map((part) => part.type === 'text' ? part.text ?? '' : part.type === 'audio' ? part.transcript ?? '' : '').filter(Boolean).join(' ');
  return text.slice(0, 90) || (message.content.some((part) => part.type === 'image') ? '[图片]' : message.content.some((part) => part.type === 'audio') ? '[语音]' : '[消息]');
}

/** 锚点消息顶边相对滚动容器视口顶部的实测位置；未渲染或消息已不存在时返回 null。 */
function anchorTopInViewport(scroller: HTMLElement, anchor: ChatScrollAnchor, messages: ChatMessage[]): number | null {
  const index = messages.findIndex((message) => message.id === anchor.messageId);
  const element = index >= 0 ? scroller.querySelector<HTMLElement>(`[data-index="${index}"]`) : null;
  if (!element) return null;
  return element.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
}

export function ChatView({ chat, viewStateRef }: { chat: ChatController; viewStateRef: ChatViewStateRef }) {
  // 头像只显示几十像素，不需要原图。
  const personaAvatar = useAuthenticatedMedia(chat.persona?.avatar ? mediaThumbnailPath(chat.persona.avatar, AVATAR_IMAGE_CSS_WIDTH) : chat.persona?.avatar, 'user', 'image');
  const userAvatar = useAuthenticatedMedia(chat.persona?.userAvatar ? mediaThumbnailPath(chat.persona.userAvatar, AVATAR_IMAGE_CSS_WIDTH) : chat.persona?.userAvatar, 'user', 'image');
  const scrollerRef = useRef<HTMLDivElement | null>(null); const bottomRef = useRef<HTMLDivElement | null>(null); const sentinelRef = useRef<HTMLDivElement | null>(null); const messagesRef = useRef<HTMLDivElement | null>(null);
  const initialViewState = useRef(viewStateRef.current).current;
  const [stickToBottom, setStickToBottom] = useState(initialViewState.stickToBottom); const [unread, setUnread] = useState(0); const [notice, setNotice] = useState<string | null>(null); const [tokenInput, setTokenInput] = useState(''); const [quote, setQuote] = useState<ChatMessage | null>(null); const [swUpdate, setSwUpdate] = useState<ServiceWorkerUpdateController | null>(null); const [historyOpen, setHistoryOpen] = useState(false); const [searchQuery, setSearchQuery] = useState(''); const [searchHits, setSearchHits] = useState<MessageSearchHit[]>([]); const [searchIndex, setSearchIndex] = useState(0); const [historyBusy, setHistoryBusy] = useState(false); const [historyError, setHistoryError] = useState<string | null>(null); const [dateQuery, setDateQuery] = useState(''); const [highlightedId, setHighlightedId] = useState<string | null>(null); const [highlightNonce, setHighlightNonce] = useState(0);
  const stickToBottomRef = useRef(initialViewState.stickToBottom); const prevFirstStartRef = useRef(0); const prevLastIdRef = useRef<string | null>(null); const loadingOlderRef = useRef(false); const didInitialScrollRef = useRef(false);
  // 锚定保持期：锚点恢复后到用户接管滚动前，每次提交都按 DOM 实测位置修正，
  // 让「估算 → 实测」级联与动态高度（图片加载等）都追不上锚点消息。
  // restoreInProgress 标记恢复窗口：scrollToIndex 与首批修正引发的滚动都不算
  // 用户滚动，只有真实手势（wheel/pointer/touch）或贴底才解除锚定。
  const anchorLockRef = useRef(false);
  const restoreInProgressRef = useRef(false);
  const releaseAnchorLock = () => { anchorLockRef.current = false; restoreInProgressRef.current = false; };
  const historyScrollTopRef = useRef(0);
  // 渲染期镜像 chat.messages：跳转的 setTimeout 回调里读它，避免拿到陈旧的数组闭包。
  const latestMessagesRef = useRef(chat.messages);
  latestMessagesRef.current = chat.messages;
  // 引用气泡按 id 取目标消息；全数组 find 在每条可见气泡上都扫一遍，长会话滚动会退化。
  const byId = useMemo(() => new Map(chat.messages.map((message) => [message.id, message])), [chat.messages]);
  const timeZone = userTimeZone();
  const virtualizer = useVirtualizer({
    count: chat.messages.length,
    getScrollElement: () => scrollerRef.current,
    getItemKey: useCallback((index: number) => chat.messages[index]?.id ?? index, [chat.messages]),
    estimateSize: useCallback((index: number) => { const current = chat.messages[index]; if (!current) return 0; return estimateMessageHeight(current, chat.messages[index - 1] ?? null, timeZone); }, [chat.messages, timeZone]),
    overscan: 8
  });

  const handleScroll = useCallback(() => { const el = scrollerRef.current; if (!el) return; const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX; stickToBottomRef.current = atBottom; setStickToBottom(atBottom); if (atBottom) { setUnread(0); releaseAnchorLock(); } }, []);
  useLayoutEffect(() => {
    const el = scrollerRef.current; if (!el) return; const messages = chat.messages; const count = messages.length; const lastId = messages[count - 1]?.id ?? null;
    if (!didInitialScrollRef.current && count > 0) {
      didInitialScrollRef.current = true; prevLastIdRef.current = lastId;
      if (initialViewState.stickToBottom) {
        virtualizer.scrollToIndex(count - 1, { align: 'end' });
        window.requestAnimationFrame(() => {
          if (scrollerRef.current) virtualizer.scrollToIndex(count - 1, { align: 'end' });
        });
      } else if (initialViewState.anchor) {
        const anchor = initialViewState.anchor;
        const index = messages.findIndex((message) => message.id === anchor.messageId);
        if (index >= 0) {
          // 锚点恢复：先按（估算的）位置跳到锚点，锚定保持期随后按 DOM 实测位置
          // 修正，直到「估算 → 实测」级联收敛——不用绝对 scrollTop、不用固定等待。
          anchorLockRef.current = true;
          restoreInProgressRef.current = true;
          virtualizer.scrollToIndex(index, { align: 'start' });
        } else {
          el.scrollTop = 0; // 锚点消息已不存在（如被撤回），回到顶部
        }
      } else {
        el.scrollTop = 0; // 无锚点（空会话离开）→ 顶部
      }
      return;
    }
    const appended = countAppended(messages, prevLastIdRef.current);
    if (loadingOlderRef.current) {
      // 向前翻页补偿：滚动量 = 首个渲染条目的 start 增量（= 前置消息的总高度）。
      // 不能用 getTotalSize() 差值——它混入其他条目的测高校正，会让补偿过头。
      const firstStart = virtualizer.getVirtualItems()[0]?.start ?? 0;
      const delta = firstStart - prevFirstStartRef.current;
      if (delta > 0) el.scrollTop += delta;
      loadingOlderRef.current = false;
    }
    else if (stickToBottomRef.current) bottomRef.current?.scrollIntoView({ block: 'end' });
    if (appended > 0 && !stickToBottomRef.current) setUnread((value) => value + appended);
    prevLastIdRef.current = lastId;
  }, [chat.messages]);

  // 锚定修正：锚定保持期内每次提交都核对锚点消息的实测位置，按偏移差值滚动，
  // 让动态高度（图片加载、语音气泡、SSE 追加、ResizeObserver 测高校正）都追不上
  // 锚点；修正引发的滚动会让锚点停在目标偏移，触发一次额外的渲染后即收敛。
  // 锚点首次到位后恢复窗口结束（此后的滚动一律视为用户接管，由手势解除锚定）。
  useLayoutEffect(() => {
    if (!anchorLockRef.current || stickToBottomRef.current) return;
    const scroller = scrollerRef.current;
    const anchor = initialViewState.anchor;
    if (!scroller || !anchor) return;
    const messages = latestMessagesRef.current;
    if (!messages.some((message) => message.id === anchor.messageId)) { releaseAnchorLock(); return; }
    const top = anchorTopInViewport(scroller, anchor, messages);
    if (top === null) return; // 锚点消息尚未渲染，等下一次提交
    const delta = anchorScrollCorrection(top, anchor.offsetFromViewportTop);
    if (Math.abs(delta) < 0.5) { restoreInProgressRef.current = false; return; }
    scroller.scrollTop += delta;
  });

  useLayoutEffect(() => () => {
    const scroller = scrollerRef.current;
    const stack = messagesRef.current;
    const stick = stickToBottomRef.current;
    if (!scroller || !stack) { viewStateRef.current = { anchor: null, stickToBottom: stick }; return; }
    // 锚点 = 视口顶部第一条可见消息；偏移为该消息顶边到视口顶部的距离。
    // rect 差值会带上 -scrollTop（内容已滚动），加回 scrollTop 才是内容坐标系偏移。
    const contentOffsetTop = stack.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    viewStateRef.current = captureChatViewState({
      scrollTop: scroller.scrollTop,
      contentOffsetTop,
      virtualItems: virtualizer.getVirtualItems(),
      stickToBottom: stick,
      getMessageId: (index) => chat.messages[index]?.id ?? null
    });
  }, [chat.messages, viewStateRef, virtualizer]);
  useEffect(() => { const scroller = scrollerRef.current; const content = messagesRef.current; if (!scroller || !content || typeof ResizeObserver === 'undefined') return; const observer = new ResizeObserver(() => { if (!loadingOlderRef.current && stickToBottomRef.current) scroller.scrollTop = scroller.scrollHeight; }); observer.observe(content); return () => observer.disconnect(); }, []);
  useEffect(() => { const sentinel = sentinelRef.current; const scroller = scrollerRef.current; if (!sentinel || !scroller) return; const observer = new IntersectionObserver((entries) => { if (entries[0]?.isIntersecting && chat.hasMore && !chat.loadingOlder && !loadingOlderRef.current) { loadingOlderRef.current = true; prevFirstStartRef.current = virtualizer.getVirtualItems()[0]?.start ?? 0; void chat.loadOlder().then((added) => { if (!added) { loadingOlderRef.current = false; prevFirstStartRef.current = virtualizer.getVirtualItems()[0]?.start ?? 0; } }); } }, { root: scroller, rootMargin: '120px 0px 0px 0px' }); observer.observe(sentinel); return () => observer.disconnect(); }, [chat.hasMore, chat.loadOlder, chat.loadingOlder]);
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
  const centerOnMessage = (id: string) => {
    const list = latestMessagesRef.current;
    const index = list.findIndex((message) => message.id === id);
    if (index < 0) return;
    virtualizer.scrollToIndex(index, { align: 'center' });
    setHighlightedId(id); setHighlightNonce((value) => value + 1);
    window.setTimeout(() => setHighlightedId((current) => (current === id ? null : current)), 1800);
  };
  const jumpToMessage = async (id: string) => {
    const target = byId.get(id) ?? await chat.ensureQuotedMessage(id);
    if (!target) { setNotice('原消息已删除或不可用'); return; }
    if (chat.messages.some((message) => message.id === id)) centerOnMessage(id);
    else window.setTimeout(() => centerOnMessage(id), 0);
  };
  const jumpToSearchHit = async (hit: MessageSearchHit) => {
    chat.addMessages([hit.message]);
    await chat.ensureQuotedMessage(hit.message.id);
    // 等异步 setState 刷新到 latestMessagesRef 后再定位。
    window.setTimeout(() => centerOnMessage(hit.message.id), 0);
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
    const message = byId.get(id) ?? await chat.ensureQuotedMessage(id);
    if (message) setQuote(message);
  }, [chat.ensureQuotedMessage, chat.messages]);
  const action = async (work: () => Promise<unknown>, success?: string) => { try { await work(); if (success) setNotice(success); } catch (error) { setNotice((error as Error).message); } };
  const statusLabel = chat.connection === 'online' ? chat.activity.thinking ? chat.activity.label ?? '正在输入' : '在线' : chat.connection === 'connecting' ? '连接中…' : chat.connection === 'unauthorized' ? '需要访问令牌' : '连接已断开，正在重试';
  const streamingMessage = useMemo<ChatMessage | null>(() => chat.streamingDraft ? {
    id: chat.streamingDraft.id,
    conversationId: 'main',
    role: 'assistant',
    createdAt: chat.streamingDraft.createdAt,
    updatedAt: chat.streamingDraft.createdAt,
    seq: Number.MAX_SAFE_INTEGER,
    status: 'sending',
    replyTo: null,
    content: [{
      id: `draft_${chat.streamingDraft.id}`,
      type: 'text',
      text: chat.streamingDraft.text,
      status: 'pending'
    }]
  } : null, [chat.streamingDraft]);

  if (chat.connection === 'unauthorized') return <div className="gate"><div className="gate-card"><h1>SOOYA</h1><p>这台服务器需要访问令牌。</p><input type="password" value={tokenInput} placeholder="WEB_CHAT_TOKEN" onChange={(e) => setTokenInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && tokenInput.trim()) { setToken(tokenInput.trim()); location.reload(); } }} /><button type="button" onClick={() => { if (tokenInput.trim()) { setToken(tokenInput.trim()); location.reload(); } }}>进入</button></div></div>;

  const persona = chat.persona ? { ...chat.persona, avatar: personaAvatar.url ?? '/avatars/sooya.svg', userAvatar: userAvatar.url ?? '/avatars/user.svg' } : null;
  const composerDisabled = !chat.ready || chat.connection !== 'online';
  const composerDisabledLabel = !chat.ready ? '正在打开你们的聊天……' : chat.connection !== 'online' ? '网络已断开' : undefined;
  return <div className="app">
    <ChatHeader persona={persona} connection={chat.connection} statusLabel={statusLabel} life={chat.life} presence={chat.presence} onSearch={() => { historyScrollTopRef.current = scrollerRef.current?.scrollTop ?? 0; setHistoryOpen((value) => !value); }} />
    {historyOpen && <section className="history-tools" aria-label="聊天历史工具" data-testid="history-tools-panel"><form onSubmit={(event) => { event.preventDefault(); void runSearch(); }}><input aria-label="搜索消息" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="搜索聊天内容" /><button type="submit" disabled={historyBusy}>搜索</button></form><div className="history-date-row"><input type="date" aria-label="按日期跳转" value={dateQuery} onChange={(event) => setDateQuery(event.target.value)} /><button type="button" disabled={historyBusy || !dateQuery} onClick={() => void runDateJump()}>跳转</button></div>{searchHits.length > 0 && <div className="history-results"><span>找到 {searchHits.length} 条 · {searchIndex + 1}/{searchHits.length}</span><button type="button" onClick={() => void jumpSearch(searchIndex - 1)}>上一个</button><button type="button" onClick={() => void jumpSearch(searchIndex + 1)}>下一个</button><span className="history-snippet">{searchHits[searchIndex]?.snippet}</span></div>}{historyError && <div className="history-error" role="alert">{historyError}</div>}<button type="button" className="history-clear" onClick={clearHistoryTools}>清除并返回原位置</button></section>}
    <div className="scroller" ref={scrollerRef} onScroll={handleScroll} onWheel={releaseAnchorLock} onPointerDown={releaseAnchorLock} onTouchStart={releaseAnchorLock} data-testid="scroller"><div ref={sentinelRef} className="load-sentinel" />{!chat.ready && <BootstrapSkeleton />}{chat.ready && chat.connection === 'offline' && chat.messages.length === 0 && chat.error && <div className="bootstrap-error" role="alert"><strong>聊天暂时无法打开</strong><span>{chat.error}</span><button type="button" onClick={() => void chat.reload()}>重新连接</button></div>}{chat.loadingOlder && <div className="history-hint">正在加载更早的消息…</div>}{!chat.hasMore && chat.ready && chat.messages.length > 0 && <div className="history-hint muted">这是你们聊天的开始</div>}{chat.ready && chat.messages.length === 0 && chat.connection !== 'offline' && <div className="empty-state"><img src={persona?.avatar ?? '/avatars/sooya.svg'} alt="" /><p>和 {persona?.name ?? 'SOOYA'} 说点什么吧</p></div>}
      <div className="messages-stack" ref={messagesRef}>
        <div className="messages virtualized" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((vi) => {
            const message = chat.messages[vi.index];
            if (!message) return null;
            const prev = chat.messages[vi.index - 1] ?? null;
            const showAvatar = shouldStartMessageGroup(prev, message, timeZone);
            const showDate = shouldStartDateSeparator(prev, message, timeZone);
            const quoted = message.replyTo ? byId.get(message.replyTo) ?? chat.quotedStates[message.replyTo]?.message ?? null : null;
            const quotedStatus = message.replyTo ? chat.quotedStates[message.replyTo]?.status : undefined;
            return (
              <div key={vi.key} data-index={vi.index} ref={virtualizer.measureElement} style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vi.start}px)`, paddingBottom: 10 }}>
                {showDate && <DateSeparator iso={message.createdAt} timeZone={timeZone} />}
                <MessageItem
                  message={message}
                  previousId={prev?.id ?? null}
                  highlightQuery={searchQuery}
                  highlighted={message.id === highlightedId}
                  highlightNonce={highlightNonce}
                  quoted={quoted}
                  quotedStatus={quotedStatus}
                  onQuotedClick={jumpToMessage}
                  quotedLabel={message.replyTo ? quotedLabel(quoted, persona?.name ?? 'SOOYA') : ''}
                  personaName={persona?.name ?? 'SOOYA'}
                  avatar={persona?.avatar ?? '/avatars/sooya.svg'}
                  userAvatar={persona?.userAvatar ?? '/avatars/user.svg'}
                  showAvatar={showAvatar}
                  timeZone={timeZone}
                  onRetry={(m) => void action(() => { setNotice('正在重试'); return chat.retryFailed(m); })}
                  onResend={(m) => void action(() => chat.sendAgain(m), '已再次发送')}
                  onQuote={setQuote}
                  onWithdraw={(m) => void action(() => chat.withdraw(m), '消息已撤回并保留上下文占位')}
                  onNotice={setNotice}
                  onOpenImage={(id) => window.dispatchEvent(new CustomEvent('sooya:open-image', { detail: { id } }))}
                />
              </div>
            );
          })}
        </div>
        {streamingMessage && (
          <div data-testid="streaming-draft">
            <MessageItem
              message={streamingMessage}
              previousId={chat.messages.at(-1)?.id ?? null}
              personaName={persona?.name ?? 'SOOYA'}
              avatar={persona?.avatar ?? '/avatars/sooya.svg'}
              userAvatar={persona?.userAvatar ?? '/avatars/user.svg'}
              showAvatar={shouldStartMessageGroup(chat.messages.at(-1) ?? null, streamingMessage, timeZone)}
              timeZone={timeZone}
            />
          </div>
        )}
        {chat.activity.thinking && !streamingMessage && (
          <div className="msg-row theirs" data-testid="typing-indicator">
            <div className="avatar-slot"><img className="avatar" src={persona?.avatar ?? '/avatars/sooya.svg'} alt="" /></div>
            <div className="msg-body"><div className="bubble bubble-text theirs typing"><span className="typing-dots"><i /><i /><i /></span></div></div>
          </div>
        )}
      </div>
      <div ref={bottomRef} className="bottom-anchor" />
    </div>
    {Object.values(chat.replyFailures).map((failure) => (
      <div className={`reply-failure-card${failure.partial ? ' partial' : ''}`} key={`${failure.batchId}:${failure.revision}`} role="status" data-testid="reply-failure-card">
        <span>{failure.message}</span>
        {failure.retryable && <button type="button" onClick={() => void action(() => chat.retryReply(failure.batchId))}>重新生成</button>}
      </div>
    ))}
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
