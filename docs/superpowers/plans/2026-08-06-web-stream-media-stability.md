# Web Streaming and Media Stability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把高频流式 delta 从已完成消息数组中分离出来，保持长会话列表引用稳定；同时让鉴权媒体按用户/管理作用域安全失效，并让图片在下载前就占据稳定尺寸。

**Architecture:** `useChat` 只把服务端确认过的消息放进 `messages`，单个 `streamingDraft` 独立承接文本增量；`ChatView` 在虚拟列表后渲染草稿并观察整段内容高度。媒体缓存条目记录鉴权作用域，令牌变更或 401/403 只清理对应作用域；每个作用域使用 generation 防止旧令牌的在途响应重新写回缓存。`ImagePart` 根据媒体元数据或 4:3 默认比例预留盒子，blob 就绪前保持不可点击。

**Tech Stack:** React 19、TypeScript 5.7、`@tanstack/react-virtual`、Vitest 4 + jsdom、Playwright 1.62、浏览器 Blob/Object URL API

---

## 实施顺序与边界

本计划是三片交付中的第 2 片。开始前必须已经完成 `2026-08-06-web-route-session.md`，因此 `App.tsx` 中应存在常驻的 `ChatSessionHost` 与可卸载的 `ChatView`。

本片不引入 IndexedDB、Service Worker 媒体缓存或新的运行时依赖，也不改变服务端 SSE/媒体协议。现有 96 MB / 240 项内存 LRU、服务端 `ETag` 和 `Cache-Control: private, immutable` 保持不变。颜色与暗色主题留给 `2026-08-06-web-warm-theme.md`。

## 文件职责映射

- 修改 `packages/web/src/lib/useChat.ts`：增加独立流式草稿状态，删除每个 delta 对正式消息数组的扫描与复制。
- 修改 `packages/web/src/lib/useChat.test.tsx`：锁定引用稳定、完成/失败/重载/resync 的草稿收敛规则。
- 修改 `packages/web/src/App.tsx`：在虚拟列表外渲染草稿，继续保持贴底观察。
- 修改 `packages/web/src/styles.css`：增加消息栈布局与稳定图片占位的最小结构样式。
- 修改 `e2e/chat.e2e.ts`：在真实流式回复中检查独立草稿到正式消息的切换。
- 修改 `packages/web/src/lib/authenticatedMedia.ts`：作用域清理、generation 隔离与鉴权失败失效。
- 修改 `packages/web/src/lib/authenticatedMedia.test.ts`：用户/管理作用域隔离及旧在途请求竞态。
- 修改 `packages/web/src/lib/api.ts`、`packages/web/src/lib/api.test.ts`：用户令牌替换/清除时清 user 媒体缓存。
- 修改 `packages/web/src/lib/admin.ts`、`packages/web/src/lib/admin.test.ts`：管理令牌替换/清除时清 admin 媒体缓存。
- 修改 `packages/web/src/lib/pushApi.test.ts`：使用公开 `clearToken()` 清理测试状态。
- 修改 `packages/web/src/components/MessageItem.tsx`、`packages/web/src/components/MessageItem.test.tsx`：稳定图片尺寸、加载态与点击门禁。
- 修改 `docs/LIMITATIONS.md`：记录当前实际缓存层与令牌失效边界。

## Task 0: 固定第 1 片后的基线

- [ ] 在仓库根目录检查分支和变更：

```powershell
git status --short --branch
```

预期：位于 `codex/web-performance-ui-refactor`；第 1 片已经提交，没有未解释的产品代码改动。

- [ ] 运行前端基线：

```powershell
npm.cmd test -w @sooya/web
npm.cmd run typecheck -w @sooya/web
```

预期：全部既有测试通过，类型检查退出码为 0。测试总数可能因第 1 片新增用例而高于最初的 30 个文件 / 401 个测试。

## Task 1: 先用测试定义独立流式草稿语义

**Files:**

- Modify: `packages/web/src/lib/useChat.test.tsx`
- Test: `packages/web/src/lib/useChat.test.tsx`

- [ ] 把现有 `describe('useChat 流式草稿', ...)` 整段替换为以下失败测试。这里刻意保存 `messages` 的对象引用，确保 delta 不再触发正式列表复制：

```tsx
describe('useChat 流式草稿', () => {
  it('delta 只累积独立草稿，正式消息数组保持同一引用', async () => {
    const { chat, push } = await mountStreaming();
    const finalizedBeforeDelta = chat().messages;

    await push('reply.text.delta', { messageId: 'm_9', delta: '你' });
    expect(chat().messages).toBe(finalizedBeforeDelta);
    expect(chat().messages.map((m) => m.id)).toEqual(['m_7']);
    expect(chat().streamingDraft).toMatchObject({ id: 'm_9', text: '你' });
    expect(chat().streamingDraft?.createdAt).toEqual(expect.any(String));

    const createdAt = chat().streamingDraft!.createdAt;
    await push('reply.text.delta', { messageId: 'm_9', delta: '好呀' });

    expect(chat().messages).toBe(finalizedBeforeDelta);
    expect(chat().streamingDraft).toEqual({ id: 'm_9', text: '你好呀', createdAt });
  });

  it('reply.completed 带正式消息时只合并一次并清掉对应草稿', async () => {
    const { chat, push } = await mountStreaming();
    await push('reply.text.delta', { messageId: 'm_9', delta: '你' });
    await push('reply.completed', {
      message: message({ id: 'm_9', seq: 9, content: [part({ id: 'p_9', text: '你好呀' })] })
    });

    expect(chat().streamingDraft).toBeNull();
    expect(chat().messages.map((m) => m.id)).toEqual(['m_7', 'm_9']);
    expect(chat().messages.at(-1)).toMatchObject({ id: 'm_9', seq: 9, status: 'sent' });
    expect(chat().messages.at(-1)!.content.map((p) => [p.id, p.text])).toEqual([['p_9', '你好呀']]);
    expect(chat().activity).toEqual({ thinking: false, label: null });
  });

  it('普通 resync 不误删草稿；同 id 正式消息到达时才收敛', async () => {
    let page = 0;
    const { chat, push } = await mountStreaming({
      messages: () => {
        page += 1;
        return page === 1
          ? messagePage([message({ id: 'm_8', seq: 8 })])
          : messagePage([message({ id: 'm_9', seq: 9, content: [part({ id: 'p_9', text: '完成文本' })] })]);
      }
    });

    await push('reply.text.delta', { messageId: 'm_9', delta: '草稿' });
    await act(async () => { await chat().resync(); });
    expect(chat().messages.map((m) => m.id)).toEqual(['m_7', 'm_8']);
    expect(chat().streamingDraft?.id).toBe('m_9');

    await act(async () => { await chat().resync(); });
    expect(chat().messages.map((m) => m.id)).toEqual(['m_7', 'm_8', 'm_9']);
    expect(chat().streamingDraft).toBeNull();
  });

  it('reply.completed 不带 message 时拉增量，并由同 id 正式消息清草稿', async () => {
    const { chat, push } = await mountStreaming({
      messages: () => messagePage([
        message({ id: 'm_7', seq: 7 }),
        message({ id: 'm_9', seq: 9, content: [part({ id: 'p_9', text: '服务端完成文本' })] })
      ])
    });
    await push('reply.text.delta', { messageId: 'm_9', delta: '临时文本' });
    await push('reply.completed', {});

    expect(messageQueries()).toEqual(['/api/messages?limit=100&since=7']);
    expect(chat().streamingDraft).toBeNull();
    expect(chat().messages.map((m) => m.id)).toEqual(['m_7', 'm_9']);
    expect(chat().messages.at(-1)!.content[0]?.text).toBe('服务端完成文本');
  });

  it('reply.failed 与完整 reload 都无条件清掉草稿', async () => {
    let boots = 0;
    const { chat, push } = await mountStreaming({
      bootstrap: () => {
        boots += 1;
        return json(bootstrapInfo({
          messages: {
            messages: [message({ id: boots === 1 ? 'm_7' : 'm_10', seq: boots === 1 ? 7 : 10 })],
            hasMore: false,
            lastEventSeq: 60,
            lastMessageSeq: boots === 1 ? 7 : 10,
            oldestSeq: boots === 1 ? 7 : 10
          }
        }));
      }
    });

    await push('reply.text.delta', { messageId: 'm_9', delta: '会失败' });
    await push('reply.failed', { error: '上游超时' });
    expect(chat().streamingDraft).toBeNull();

    await push('reply.text.delta', { messageId: 'm_11', delta: '会重载' });
    await push('system.notice', { action: 'reload' });
    expect(chat().streamingDraft).toBeNull();
    expect(chat().messages.map((m) => m.id)).toEqual(['m_10']);
  });
});
```

- [ ] 在现有 `reply.failed 归零活动...` 用例中，先发送一个 delta，并新增断言：

```tsx
    await push('reply.text.delta', { messageId: 'm_9', delta: '未完成' });
    await push('reply.failed', { error: '上游超时', message: message({ id: 'm_9', seq: 9, status: 'failed' }) });

    expect(chat().streamingDraft).toBeNull();
```

- [ ] 运行定向测试，确认失败原因是 `streamingDraft` 尚不存在，且旧实现改变了 `messages` 引用：

```powershell
npm.cmd test -w @sooya/web -- src/lib/useChat.test.tsx
```

预期：新增流式草稿测试失败；不是测试环境、网络 mock 或语法错误。

## Task 2: 在 useChat 中分离草稿与正式消息

**Files:**

- Modify: `packages/web/src/lib/useChat.ts`
- Test: `packages/web/src/lib/useChat.test.tsx`

- [ ] 在 `QuotedMessageState` 后新增公开类型：

```ts
export interface StreamingDraft {
  id: string;
  text: string;
  createdAt: string;
}
```

- [ ] 在 `useChat()` 顶部状态区新增草稿状态，并把旧 Map ref 替换为单草稿 ref：

```ts
  const [streamingDraft, setStreamingDraft] = useState<StreamingDraft | null>(null);
  const streamingDraftRef = useRef<StreamingDraft | null>(null);
```

删除：

```ts
  const draftRef = useRef(new Map<string, string>());
```

- [ ] 在 `trackSeq` 前加入两个稳定 helper。`updateActivity` 对完全相同的阶段复用旧对象，避免重复事件制造无意义 render：

```ts
  const updateActivity = useCallback((next: ActivityState) => {
    setActivity((current) => current.thinking === next.thinking && current.label === next.label ? current : next);
  }, []);

  const clearStreamingDraft = useCallback((messageId?: string) => {
    const current = streamingDraftRef.current;
    if (!current || (messageId && current.id !== messageId)) return;
    streamingDraftRef.current = null;
    setStreamingDraft(null);
  }, []);
```

- [ ] 把 `applyMessages` 改为只在 incoming 含同 id 正式消息时收敛草稿：

```ts
  const applyMessages = useCallback((incoming: ChatMessage[]) => {
    trackSeq(incoming);
    const draft = streamingDraftRef.current;
    if (draft && incoming.some((message) => message.id === draft.id)) clearStreamingDraft(draft.id);
    setMessages((previous) => mergeMessages(previous, incoming));
  }, [clearStreamingDraft, trackSeq]);
```

不得在 `resync()` 开始或成功后无条件清草稿：无关的 catch-up 页可能先于最终消息到达。

- [ ] 把流事件的活动状态调用改为 `updateActivity(...)`，并用以下分支替换 delta/completed/failed：

```ts
          case 'reply.text.delta': {
            const id = String(data.messageId ?? '');
            const delta = String(data.delta ?? '');
            updateActivity({ thinking: true, label: '正在输入' });
            if (id && delta) {
              const previous = streamingDraftRef.current;
              const next: StreamingDraft = previous?.id === id
                ? { ...previous, text: previous.text + delta }
                : { id, text: delta, createdAt: new Date().toISOString() };
              streamingDraftRef.current = next;
              setStreamingDraft(next);
            }
            break;
          }
          case 'reply.completed': {
            updateActivity({ thinking: false, label: null });
            const message = data.message as ChatMessage | undefined;
            if (message) applyMessages([message]);
            else void resync();
            break;
          }
          case 'reply.failed': {
            updateActivity({ thinking: false, label: null });
            clearStreamingDraft();
            const message = data.message as ChatMessage | undefined;
            if (message) applyMessages([message]);
            setError(typeof data.error === 'string' ? data.error : '回复失败');
            break;
          }
```

把同一 switch 中其余 `setActivity(...)` 改为 `updateActivity(...)`，并把 `startStream` 的依赖数组补齐：

```ts
  }, [applyMessages, clearStreamingDraft, refreshLife, resync, updateActivity]);
```

- [ ] 在 `reload()` 的 reset 段替换旧 Map 清理：

```ts
      maxSeqRef.current = 0;
      clearStreamingDraft();
      quotedStatesRef.current.clear();
      quotedRequestsRef.current.clear();
      setQuotedStates({});
```

把 reload 成功后的活动状态改为：

```ts
      updateActivity({ thinking: false, label: null });
```

并把依赖数组更新为：

```ts
  }, [clearStreamingDraft, startStream, trackSeq, updateActivity]);
```

- [ ] 在返回对象中紧跟 `messages` 暴露草稿：

```ts
  return {
    messages,
    streamingDraft,
    persona,
```

- [ ] 删除文件末尾整个 `applyDraft(...)` 函数；用静态搜索保证正式消息数组不再承担 delta：

```powershell
rg -n "applyDraft|draftRef|setMessages\(.*reply\.text\.delta" packages/web/src/lib/useChat.ts
```

预期：没有匹配项。

- [ ] 运行定向测试和类型检查：

```powershell
npm.cmd test -w @sooya/web -- src/lib/useChat.test.tsx
npm.cmd run typecheck -w @sooya/web
```

预期：`useChat.test.tsx` 全部通过，类型检查退出码为 0。

- [ ] 提交流式状态层：

```powershell
git add packages/web/src/lib/useChat.ts packages/web/src/lib/useChat.test.tsx
git commit -m "perf(web): separate streaming draft from message history"
```

## Task 3: 在虚拟列表外显示草稿并验证真实流式切换

**Files:**

- Modify: `packages/web/src/App.tsx`
- Modify: `packages/web/src/styles.css`
- Modify: `e2e/chat.e2e.ts`

- [ ] 在 `ChatView` 中、`statusLabel` 之后创建仅供渲染的临时消息；`createdAt` 来自草稿首次 delta，不能在每次 render 改变：

```tsx
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
```

- [ ] 对 scroller 中现有 JSX 做两处精确结构变换，让 `messagesRef` 观察整个消息栈，同时完全保留正式消息 map 的现有实现。

先把虚拟列表的开始标签：

```tsx
<div className="messages virtualized" ref={messagesRef} style={{ height: virtualizer.getTotalSize() }}>
```

替换为嵌套的两个开始标签：

```tsx
<div className="messages-stack" ref={messagesRef}>
  <div className="messages virtualized" style={{ height: virtualizer.getTotalSize() }}>
```

然后在 `virtualizer.getVirtualItems().map(...)` 后、旧 typing indicator 前关闭虚拟列表，并用以下完整尾部替换旧 typing indicator 与 bottom anchor：

```tsx
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
```

删除 `hasStreamingBubble(...)`。不得把草稿塞进 `virtualizer.count`，否则每个 delta 仍会让虚拟列表重算条目。

- [ ] 在 `.messages` 前新增最小结构样式：

```css
.messages-stack {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

[data-testid='streaming-draft'] {
  min-width: 0;
}
```

`ResizeObserver` 继续观察 `messagesRef.current`，此时它覆盖虚拟列表、草稿和 typing indicator；贴底用户会随 delta 高度增长跟随，读历史用户不会被强制拉回底部。

- [ ] 把 `e2e/chat.e2e.ts` 的增量测试改为显式检查草稿节点：

```ts
test('shows an isolated streaming draft before committing the final reply', async ({ page }) => {
  await control({ queue: ['一二三四五六七八九十，这是一段比较长的流式回复内容。'], chunkDelayMs: 200 });
  await page.goto('/');
  await send(page, '慢慢说');

  const finalizedBefore = await page.locator('[data-testid="message"][data-role="assistant"]').count();
  const draft = page.getByTestId('streaming-draft');
  await expect(draft).toContainText('一二三', { timeout: 15_000 });
  await expect(page.locator('[data-testid="message"][data-role="assistant"]')).toHaveCount(finalizedBefore);
  await expect(page.getByTestId('typing-indicator')).toHaveCount(0);

  await waitForReply(page);
  await expect(draft).toHaveCount(0);
  await expect(page.locator('[data-testid="message"][data-role="assistant"]').last())
    .toContainText('一二三四五六七八九十，这是一段比较长的流式回复内容。');
});
```

- [ ] 运行单测、类型检查与 desktop E2E：

```powershell
npm.cmd test -w @sooya/web -- src/lib/useChat.test.tsx
npm.cmd run typecheck -w @sooya/web
npm.cmd run test:e2e -- --project=desktop chat.e2e.ts
```

预期：增量出现时 `streaming-draft` 可见且正式助手消息数量不变；完成后草稿消失，只留下服务端正式消息。

- [ ] 提交渲染层：

```powershell
git add packages/web/src/App.tsx packages/web/src/styles.css e2e/chat.e2e.ts
git commit -m "perf(web): render streaming reply outside virtual history"
```

## Task 4: 先测试媒体缓存的作用域失效与在途竞态

**Files:**

- Modify: `packages/web/src/lib/authenticatedMedia.test.ts`
- Test: `packages/web/src/lib/authenticatedMedia.test.ts`

- [ ] 在 `describe('媒体缓存', ...)` 中追加作用域清理测试：

```ts
  it('只清指定鉴权作用域，不撤销另一作用域的 URL', async () => {
    stubMedia();
    const user = await acquireAuthenticatedMedia('/api/media/shared', opts);
    const adminOptions = { ...opts, scope: 'admin' as const, token: 'admin-secret' };
    const admin = await acquireAuthenticatedMedia('/api/media/shared', adminOptions);
    const revoke = vi.spyOn(URL, 'revokeObjectURL');

    clearMediaCache('user');

    expect(takeCachedMedia('/api/media/shared', key)).toBeNull();
    expect(takeCachedMedia('/api/media/shared', { scope: 'admin', expected: 'image' })?.url).toBe(admin.url);
    expect(revoke).toHaveBeenCalledWith(user.url);
    expect(revoke).not.toHaveBeenCalledWith(admin.url);
  });
```

- [ ] 追加旧令牌请求不能污染新 generation 的竞态测试：

```ts
  it('令牌切换后丢弃旧作用域的在途响应，新请求不与它合并', async () => {
    let resolveOld!: (response: Response) => void;
    const oldResponse = new Promise<Response>((resolve) => { resolveOld = resolve; });
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => oldResponse)
      .mockResolvedValueOnce(new Response(new Blob(['new-value'], { type: 'image/png' }), {
        status: 200,
        headers: { 'content-type': 'image/png' }
      }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) =>
      blob.size === 3 ? 'blob:old-generation' : 'blob:new-generation');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);

    const oldRequest = acquireAuthenticatedMedia('/api/media/race', opts);
    clearMediaCache('user');
    const newRequest = acquireAuthenticatedMedia('/api/media/race', { ...opts, token: 'new-secret' });
    resolveOld(new Response(new Blob(['old'], { type: 'image/png' }), {
      status: 200,
      headers: { 'content-type': 'image/png' }
    }));

    await expect(oldRequest).rejects.toMatchObject({ code: 'stale_auth' });
    await expect(newRequest).resolves.toMatchObject({ url: 'blob:new-generation' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(revoke).toHaveBeenCalledWith('blob:old-generation');
    expect(takeCachedMedia('/api/media/race', key)?.url).toBe('blob:new-generation');
  });
```

- [ ] 把 HTTP 分类用例中的 401/403 拆成专门测试，验证鉴权失败只清对应 scope：

```ts
  it.each([401, 403])('HTTP %i 清理请求所属作用域的缓存', async (status) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(new Blob(['user'], { type: 'image/png' }), { status: 200, headers: { 'content-type': 'image/png' } }))
      .mockResolvedValueOnce(new Response(new Blob(['admin'], { type: 'image/png' }), { status: 200, headers: { 'content-type': 'image/png' } }))
      .mockResolvedValueOnce(new Response('', { status }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(URL, 'createObjectURL').mockReturnValueOnce('blob:user').mockReturnValueOnce('blob:admin');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);

    await acquireAuthenticatedMedia('/api/media/user-cached', { scope: 'user', token: 'user-secret', expected: 'image' });
    await acquireAuthenticatedMedia('/api/media/admin-cached', { scope: 'admin', token: 'admin-secret', expected: 'image' });
    await expect(fetchAuthenticatedMedia('/api/media/denied', {
      scope: 'user', token: 'expired', expected: 'image'
    })).rejects.toMatchObject({ code: 'auth', status });

    expect(takeCachedMedia('/api/media/user-cached', { scope: 'user', expected: 'image' })).toBeNull();
    expect(takeCachedMedia('/api/media/admin-cached', { scope: 'admin', expected: 'image' })).not.toBeNull();
  });
```

从原 `it.each` HTTP 分类表中删除 401/403 两行，避免重复但不检查失效行为的弱测试。

- [ ] 在 retry 分类测试中加入：

```ts
    expect(isRetriableMediaError(new AuthenticatedMediaError('stale_auth', null, ''))).toBe(true);
```

- [ ] 运行测试并确认新增用例因 `clearMediaCache(scope)` 与 generation 尚不存在而失败：

```powershell
npm.cmd test -w @sooya/web -- src/lib/authenticatedMedia.test.ts
```

## Task 5: 实现作用域缓存清理并接入令牌生命周期

**Files:**

- Modify: `packages/web/src/lib/authenticatedMedia.ts`
- Modify: `packages/web/src/lib/api.ts`
- Modify: `packages/web/src/lib/api.test.ts`
- Modify: `packages/web/src/lib/admin.ts`
- Modify: `packages/web/src/lib/admin.test.ts`
- Modify: `packages/web/src/lib/pushApi.test.ts`

- [ ] 在 `MediaCacheEntry` 增加 scope，并在缓存状态旁加入每个作用域的 generation：

```ts
interface MediaCacheEntry {
  key: string;
  scope: MediaAuthScope;
  url: string;
  blob: Blob;
  contentType: string;
  refs: number;
  bytes: number;
  used: number;
}

const scopeGeneration: Record<MediaAuthScope, number> = { user: 0, admin: 0 };
```

- [ ] 用以下实现替换 `clearMediaCache()`。无参数仍保留测试与页面卸载所需的“全清”兼容行为：

```ts
export function clearMediaCache(scope?: MediaAuthScope): void {
  const scopes: MediaAuthScope[] = scope ? [scope] : ['user', 'admin'];
  for (const current of scopes) scopeGeneration[current] += 1;
  for (const entry of [...mediaCache.values()]) {
    if (!scope || entry.scope === scope) drop(entry);
  }
  if (!scope) cachedBytes = 0;
}
```

`drop()` 已按 `entry.bytes` 维护全局字节数；有 scope 时不得把 `cachedBytes` 直接归零。

- [ ] 在 `acquireAuthenticatedMedia()` 缓存 miss 后捕获 generation，并以它区分 in-flight 请求。用以下代码替换从 `const key` 到 `const entry = await pending` 的区段：

```ts
  const key = mediaCacheKey(path, options);
  const generation = scopeGeneration[options.scope];
  const inflightKey = `${key}|generation:${generation}`;
  const pending = inflight.get(inflightKey) ?? (async () => {
    try {
      const result = await fetchAuthenticatedMediaWithRetry(path, { ...options, signal: undefined });
      if (scopeGeneration[options.scope] !== generation) {
        releaseMediaUrl(result.url);
        throw new AuthenticatedMediaError('stale_auth', null, '媒体访问凭证已更新，请重试');
      }
      const entry: MediaCacheEntry = {
        key,
        scope: options.scope,
        url: result.url,
        blob: result.blob,
        contentType: result.contentType,
        refs: 0,
        bytes: result.blob.size,
        used: ++clock
      };
      mediaCache.set(key, entry);
      cachedBytes += entry.bytes;
      evictIfNeeded();
      return entry;
    } finally {
      inflight.delete(inflightKey);
    }
  })();
  inflight.set(inflightKey, pending);
  const entry = await pending;
```

- [ ] 在 `fetchAuthenticatedMedia()` 的非成功响应分支中先清请求 scope：

```ts
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) clearMediaCache(options.scope);
    throw responseError(response.status);
  }
```

- [ ] 把 `stale_auth` 加进可重试集合：

```ts
const RETRIABLE_CODES = new Set(['network', 'server', 'rate_limit', 'missing', 'blob', 'empty', 'stale_auth']);
```

它表示旧请求结果被主动丢弃；hook 应显示可重试状态，而不能复用旧 blob。

- [ ] 修改 `packages/web/src/lib/api.test.ts` imports：

```ts
import { api, ApiError, clearToken, getToken, mediaUrl, setToken } from './api.js';
import {
  acquireAuthenticatedMedia,
  clearMediaCache,
  takeCachedMedia
} from './authenticatedMedia.js';
```

删除“api.ts 不提供清除令牌函数”用例，改为：

```ts
  it('用户令牌只在值变化或清除时失效 user 媒体缓存', async () => {
    let created = 0;
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:token-${++created}`);
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob(['image'], { type: 'image/png' }), {
      status: 200,
      headers: { 'content-type': 'image/png' }
    })));
    setToken('user-secret');
    setAdminToken('admin-secret');
    await acquireAuthenticatedMedia('/api/media/user-token-test', { scope: 'user', token: 'user-secret', expected: 'image' });
    await acquireAuthenticatedMedia('/api/media/admin-token-test', { scope: 'admin', token: 'admin-secret', expected: 'image' });

    setToken('user-secret');
    expect(takeCachedMedia('/api/media/user-token-test', { scope: 'user', expected: 'image' })).not.toBeNull();

    setToken('next-secret');
    expect(takeCachedMedia('/api/media/user-token-test', { scope: 'user', expected: 'image' })).toBeNull();
    expect(takeCachedMedia('/api/media/admin-token-test', { scope: 'admin', expected: 'image' })).not.toBeNull();

    await acquireAuthenticatedMedia('/api/media/user-after-replace', { scope: 'user', token: 'next-secret', expected: 'image' });
    clearToken();
    expect(getToken()).toBeNull();
    expect(takeCachedMedia('/api/media/user-after-replace', { scope: 'user', expected: 'image' })).toBeNull();
  });
```

在该测试文件的 `afterEach` 中调用 `clearMediaCache()`，保证作用域缓存不跨用例。

- [ ] 在 `packages/web/src/lib/api.ts` 引入 cache helper，并替换 token API：

```ts
import { clearMediaCache, credentialFreeMediaPath } from './authenticatedMedia.js';

const TOKEN_KEY = 'sooya.token';

export function getToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}

export function setToken(token: string): void {
  const changed = getToken() !== token;
  try { localStorage.setItem(TOKEN_KEY, token); } catch { /* private mode */ }
  if (changed) clearMediaCache('user');
}

export function clearToken(): void {
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ }
  clearMediaCache('user');
}
```

- [ ] 修改 `packages/web/src/lib/admin.test.ts` imports：

```ts
import {
  acquireAuthenticatedMedia,
  clearMediaCache,
  takeCachedMedia
} from './authenticatedMedia.js';
```

在“admin 令牌存取”中追加：

```ts
  it('管理令牌只在值变化或清除时失效 admin 媒体缓存', async () => {
    let created = 0;
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:admin-token-${++created}`);
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob(['image'], { type: 'image/png' }), {
      status: 200,
      headers: { 'content-type': 'image/png' }
    })));
    setToken('user-secret');
    setAdminToken('admin-secret');
    await acquireAuthenticatedMedia('/api/media/user-admin-test', { scope: 'user', token: 'user-secret', expected: 'image' });
    await acquireAuthenticatedMedia('/api/media/admin-admin-test', { scope: 'admin', token: 'admin-secret', expected: 'image' });

    setAdminToken('admin-secret');
    expect(takeCachedMedia('/api/media/admin-admin-test', { scope: 'admin', expected: 'image' })).not.toBeNull();

    setAdminToken('next-secret');
    expect(takeCachedMedia('/api/media/admin-admin-test', { scope: 'admin', expected: 'image' })).toBeNull();
    expect(takeCachedMedia('/api/media/user-admin-test', { scope: 'user', expected: 'image' })).not.toBeNull();

    await acquireAuthenticatedMedia('/api/media/admin-after-replace', { scope: 'admin', token: 'next-secret', expected: 'image' });
    clearAdminToken();
    expect(takeCachedMedia('/api/media/admin-after-replace', { scope: 'admin', expected: 'image' })).toBeNull();
  });
```

在该测试文件的 `afterEach` 中调用 `clearMediaCache()`。

- [ ] 在 `packages/web/src/lib/admin.ts` 引入 `clearMediaCache`，并替换令牌 setter/clearer：

```ts
import { clearMediaCache } from './authenticatedMedia.js';

export function setAdminToken(token: string): void {
  const changed = getAdminToken() !== token;
  try { localStorage.setItem(ADMIN_TOKEN_KEY, token); } catch { /* private mode */ }
  if (changed) clearMediaCache('admin');
}

export function clearAdminToken(): void {
  try { localStorage.removeItem(ADMIN_TOKEN_KEY); } catch { /* private mode */ }
  clearMediaCache('admin');
}
```

- [ ] 把 `packages/web/src/lib/pushApi.test.ts` 的直接 `localStorage.removeItem('sooya.token')` 清理改为公开 API：

```ts
import { clearToken, setToken } from './api.js';

afterEach(() => {
  clearToken();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
```

删除“没有 clear()”的旧注释。

- [ ] 运行缓存、令牌、hook 回归与类型检查：

```powershell
npm.cmd test -w @sooya/web -- src/lib/authenticatedMedia.test.ts src/lib/useAuthenticatedMedia.test.tsx src/lib/api.test.ts src/lib/admin.test.ts src/lib/pushApi.test.ts
npm.cmd run typecheck -w @sooya/web
```

预期：用户令牌变化不会清 admin 缓存，管理令牌变化不会清 user 缓存；旧 generation 请求被撤销且不进入 cache；全部测试和类型检查通过。

- [ ] 提交媒体鉴权边界：

```powershell
git add packages/web/src/lib/authenticatedMedia.ts packages/web/src/lib/authenticatedMedia.test.ts packages/web/src/lib/api.ts packages/web/src/lib/api.test.ts packages/web/src/lib/admin.ts packages/web/src/lib/admin.test.ts packages/web/src/lib/pushApi.test.ts
git commit -m "fix(web): scope media cache to auth lifecycle"
```

## Task 6: 先测试、再实现稳定图片占位

**Files:**

- Modify: `packages/web/src/components/MessageItem.test.tsx`
- Modify: `packages/web/src/components/MessageItem.tsx`
- Modify: `packages/web/src/styles.css`
- Modify: `packages/web/src/components/overlays.css`

- [ ] 把 `MessageItem.test.tsx` 的 Vitest import 加上 `vi`，并引入媒体缓存清理：

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMediaCache } from '../lib/authenticatedMedia.js';
```

在现有 `afterEach` 尾部加入 `clearMediaCache()`、`vi.restoreAllMocks()` 与 `vi.unstubAllGlobals()`。

- [ ] 追加图片 helper 和失败测试：

```tsx
function imageMessage(width?: number | null, height?: number | null): ChatMessage {
  return message({
    id: 'm_image',
    content: [{
      id: 'p_image',
      type: 'image',
      status: 'sent',
      mediaId: 'media_1',
      media: {
        id: 'media_1',
        kind: 'image',
        mime: 'image/png',
        bytes: 123,
        width,
        height,
        url: '/api/media/media_1',
        name: '照片.png'
      }
    }]
  });
}

describe('MessageItem 图片占位', () => {
  it('下载完成前预留真实比例且禁止打开，完成后不改变盒子几何', async () => {
    let resolveFetch!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve; })));
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:image-ready');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const open = vi.fn();

    await render(<MessageItem {...common} showAvatar={false} message={imageMessage(800, 1200)} onOpenImage={open} />);
    const button = container.querySelector<HTMLButtonElement>('.image-part')!;

    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.style.aspectRatio).toBe(String(800 / 1200));
    expect(button.style.width).toBe('213px');
    expect(button.querySelector('.image-part-placeholder')).not.toBeNull();
    button.click();
    expect(open).not.toHaveBeenCalled();

    await act(async () => {
      resolveFetch(new Response(new Blob(['image'], { type: 'image/png' }), {
        status: 200,
        headers: { 'content-type': 'image/png' }
      }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(button.disabled).toBe(false);
    expect(button.hasAttribute('aria-busy')).toBe(false);
    expect(button.style.aspectRatio).toBe(String(800 / 1200));
    expect(button.style.width).toBe('213px');
    expect(button.querySelector('img')?.getAttribute('src')).toBe('blob:image-ready');
    expect(button.querySelector('.image-part-placeholder')).toBeNull();
  });

  it('缺失或非法尺寸元数据时使用 4:3 默认占位', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob(['image'], { type: 'image/png' }), {
      status: 200,
      headers: { 'content-type': 'image/png' }
    })));
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:default-ratio');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    await render(<MessageItem {...common} showAvatar={false} message={imageMessage(null, 0)} />);

    const button = container.querySelector<HTMLElement>('.image-part')!;
    expect(button.style.aspectRatio).toBe(String(4 / 3));
    expect(button.style.width).toBe('260px');
  });
});
```

竖图宽度期望为 `round(320 × 800/1200) = 213px`，因此高度不超过现有 320px 上限。

- [ ] 运行用例，确认失败点是按钮尚未预留尺寸/禁用以及 placeholder 不存在：

```powershell
npm.cmd test -w @sooya/web -- src/components/MessageItem.test.tsx
```

- [ ] 在 `MessageItem.tsx` 的 `ImagePart` 中，用安全比例与稳定宽度替换旧 `ratio`，并替换返回按钮：

```tsx
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
```

- [ ] 更新 `styles.css` 的图片结构样式：

```css
.image-part {
  position: relative;
  display: block;
  max-width: min(260px, 62vw);
  max-height: 320px;
  border-radius: 14px;
  overflow: hidden;
  box-shadow: var(--shadow-soft);
  background: var(--panel);
}

.image-part:disabled {
  cursor: wait;
}

.image-part img,
.image-part-placeholder {
  display: block;
  width: 100%;
  height: 100%;
}

.image-part img {
  object-fit: cover;
}

.image-part-placeholder {
  background: var(--panel-alt);
}
```

删除旧 `.image-part img` 中的 `height: auto` 与 `max-height: 320px`。主题片会给 placeholder 加基于语义 token 的 shimmer；本片先保证几何和交互稳定。

- [ ] 检查 `components/overlays.css` 顶部 `.image-part` 不会覆盖宽高、`aspect-ratio` 或 disabled 状态；只保留按钮 reset：

```css
.image-part {
  padding: 0;
  border: 0;
  cursor: pointer;
}

.image-part:disabled {
  cursor: wait;
}
```

- [ ] 运行组件、查看器、估高回归与类型检查：

```powershell
npm.cmd test -w @sooya/web -- src/components/MessageItem.test.tsx src/components/ImageViewerHost.test.tsx src/lib/estimateMessageHeight.test.ts
npm.cmd run typecheck -w @sooya/web
```

预期：未加载按钮有稳定非零盒子且不可打开；加载后同一按钮内替换成图片；viewer 仍从 `data-src` 发现可查看图片。

- [ ] 提交稳定占位：

```powershell
git add packages/web/src/components/MessageItem.tsx packages/web/src/components/MessageItem.test.tsx packages/web/src/styles.css packages/web/src/components/overlays.css
git commit -m "fix(web): reserve authenticated image geometry"
```

## Task 7: 文档与整片验证

**Files:**

- Modify: `docs/LIMITATIONS.md`
- Test: all files touched by this plan

- [ ] 更新 `docs/LIMITATIONS.md` 的媒体缓存说明，明确三层事实：

```md
- 受保护媒体使用服务端私有 HTTP 缓存（ETag + immutable）与前端 96 MB / 240 项内存 LRU；不写入 Service Worker Cache 或 IndexedDB。用户令牌和管理令牌变更、清除或收到 401/403 时，只失效对应鉴权作用域；旧令牌的在途响应会被丢弃。
```

- [ ] 搜索不得残留的旧实现：

```powershell
rg -n "applyDraft|draftRef|hasStreamingBubble|api\.ts 不提供清除令牌|there is no clear" packages/web/src
```

预期：没有匹配项。

- [ ] 运行格式与差异检查：

```powershell
git diff --check
```

预期：无尾随空格、冲突标记或空白错误。

- [ ] 运行整套前端验证：

```powershell
npm.cmd test -w @sooya/web
npm.cmd run typecheck -w @sooya/web
npm.cmd run build -w @sooya/web
npm.cmd run test:e2e -- --project=desktop chat.e2e.ts navigation.e2e.ts
```

预期：全部单测通过，类型检查与构建退出码为 0；真实流式草稿、正式消息收敛、路由会话保持均通过。

- [ ] 在 Chromium DevTools 或 Playwright trace 中完成一次人工性能核对：

1. 打开包含至少 100 条消息的会话。
2. 触发一段至少 30 个 delta 的回复。
3. 确认 delta 期间虚拟列表的正式 message 节点数量不变化。
4. 确认贴底时随草稿增高跟随；向上滚动后不被拉回底部。
5. 在图片请求未完成时确认占位有高度、不可点击，完成后布局不跳动。

- [ ] 提交文档与本片收尾：

```powershell
git add docs/LIMITATIONS.md
git commit -m "docs: document scoped media cache behavior"
git status --short
```

预期：提交成功，`git status --short` 无输出。

## 完成标准

- 每个 `reply.text.delta` 只更新 `streamingDraft`，不扫描、排序或复制 `messages`。
- 正式消息仅在 received/updated/completed/resync 时合并；同 id 到达时草稿自动清除。
- 失败与完整 reload 清草稿；无关 resync 不误删草稿。
- 用户与管理媒体缓存可独立失效，旧 token 的在途响应无法重新写回。
- 图片从首次 render 起具有稳定比例和宽高边界，blob 未就绪时不可打开。
- 不新增 IndexedDB、Service Worker 媒体缓存、全局消息入场动画或运行时依赖。
