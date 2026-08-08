# Agent F — Mobile 虚拟列表滚动恢复结构性修复（anchor-based restore）

## SUMMARY

将聊天虚拟列表的滚动恢复从「绝对 scrollTop 保存 + min/max 钳制」重构为
「消息锚点」模型：离开时保存视口顶部第一条可见消息（messageId + 顶边到视口
顶部的偏移），返回时 `virtualizer.scrollToIndex` 跳到锚点后，在锚定保持期内
按 DOM 实测位置持续修正，直到「估算 → 实测」测量级联收敛。动态高度（图片
加载、语音气泡、SSE 追加、ResizeObserver 测高校正）不再能把恢复位置推走。

修复过程还发现并解决了三处相关问题：

1. **卸载捕获的内容偏移错误**：`stack.top - scroller.top` 的 rect 差值已包含
   `-scrollTop`（内容已滚动），导致锚点选到视口下方约一屏的条目；改为
   `差值 + scrollTop`（内容坐标系偏移）。这是 e2e 中 after 比 before 恰好
   大一个视口/条目高度的直接原因。
2. **锚定锁被自身滚动误释放**：恢复路径的 `scrollToIndex` 与修正滚动都会触发
   scroll 事件，原「偏离目标即视为用户接管」的判断把锁提前释放；改为只有真实
   手势（wheel/pointer/touch）或贴底才解除锚定（`restoreInProgress` 标记恢复
   窗口）。
3. **loadOlder 前置补偿过冲**：`scrollTop += (totalSize - prevTotalSize)` 混入
   无关条目的测高校正；改为按首个渲染条目 `start` 增量滚动（精确的前置高度）。

e2e 测试侧（仅时序改进，未加宽断言）：基线采集前等待
scrollTop/scrollHeight/消息数三重稳定（SSE 管道与测量级联结束），读历史位置
设在加载哨兵上边距（120px）之外并二次确认；断言保持 `< 60px`，另追加锚点
契约断言（返回后视口顶部消息 id 相同、偏移差 < 60px）。

## FILES_CHANGED

- `packages/web/src/lib/chatViewState.ts` — `ChatScrollAnchor { messageId;
  offsetFromViewportTop }`、`ChatViewState { anchor; stickToBottom }`、
  `captureChatViewState`（纯函数）、`anchorScrollCorrection`、`isAnchorSettled`
- `packages/web/src/lib/chatViewState.test.ts` — 锚点捕获/修正纯函数测试（重写）
- `packages/web/src/App.tsx` — 卸载捕获、初始恢复（scrollToIndex + 锚定修正
  布局效应）、loadOlder 补偿、手势解除锚定
- `packages/web/src/App.viewState.test.tsx` — 适配新状态形状
- `packages/web/src/App.anchorRestore.test.tsx` — 新增：mock virtualizer +
  布局模拟的锚点恢复测试（8 用例）
- `e2e/navigation.e2e.ts` — settle 谓词 + 锚点断言
- `docs/E2E-ISSUE-SCROLL-RESTORE.md` — 追加「已修复」章节（原分析保留）

## TESTS

- web 单测：36 文件 **457 用例全部通过**（`cd packages/web && npx vitest run`）；
  其中锚点相关 17 用例：`chatViewState.test.ts`（8）、`App.anchorRestore.test.tsx`（8）、
  `App.viewState.test.tsx`（1）。
- typecheck：`cd packages/web && npm run typecheck` 0 error。
- e2e：`npx playwright test navigation --retries=0`（构建后）**连续 6 轮全绿**，
  每轮 4/4（desktop + mobile 各 2 例），滚动恢复测试 12/12 次通过：
  - 轮 1：4/4（scroll 24.5s / 24.4s）
  - 轮 2：4/4（24.4s / 24.4s）
  - 轮 3：4/4（24.5s / 24.5s）
  - 轮 4：4/4（24.8s / 24.8s）
  - 轮 5：4/4（24.7s / 24.7s）
  - 轮 6：4/4（24.6s / 24.6s）
- 插桩实测（开发期）：before=300 → after=300（diff=0），锚点消息 id 与
  顶边偏移（-29）前后完全一致。

## PUBLIC_API

`packages/web/src/lib/chatViewState.ts`：

- 新增 `interface ChatScrollAnchor { messageId: string; offsetFromViewportTop: number }`
- `interface ChatViewState` 改为 `{ anchor: ChatScrollAnchor | null; stickToBottom: boolean }`
  （原 `scrollTop` 字段删除）
- `INITIAL_CHAT_VIEW_STATE` 改为 `{ anchor: null, stickToBottom: true }`
- 新增 `captureChatViewState(options): ChatViewState`（options：scrollTop、
  contentOffsetTop、virtualItems、stickToBottom、getMessageId）
- 新增 `anchorScrollCorrection(anchorTopInViewport, offsetFromViewportTop): number`
- 新增 `isAnchorSettled(anchorTopInViewport, offsetFromViewportTop): boolean`
- 删除 `restoredScrollTop()`

消费方仅 `packages/web/src/App.tsx`（ChatView/ChatSessionHost），无其他外部
调用；`ChatViewStateRef`（`{ current: ChatViewState }`）形状不变。

## MIGRATION_NEEDS

无。滚动状态仅存于运行时 ref（ChatSessionHost → ChatView），无持久化、无
服务端契约、无跨模块依赖。`docs/NEXT-PHASE-CONTRACTS.md` 未改动。

## ENV_NEEDS

无。依赖与既有项目一致（@tanstack/react-virtual ^3.14.9、React 19、Playwright）。
注意：e2e 需要本 worktree 完整安装依赖（`npm ci`，含 better-sqlite3 原生
模块）与 `npm run build` 后才能跑通。

## INTEGRATION_STEPS

无——本模块自包含（App.tsx 内全部改动，未触碰 AppShell/组件/服务端）。

与 Agent E（inner-thought UI）兼容性注意点：

- Agent E 若向 `packages/web/src/components/MessageItem.tsx` 或消息气泡加
  高度变化的内容（如思考过程折叠/展开），高度变化会被锚定保持期自动吸收
  （锚点自身高度变化不移动其顶边，前方条目变化由修正循环跟随）；
- Agent E 若给消息 DOM 增加新元素，请勿改动 `data-index` 包装层与
  `data-testid="message"` 结构——`anchorTopInViewport` 与 e2e 的
  `captureAnchor` 依赖它们；
- 若 Agent E 需要在滚动容器内新增固定定位层，注意 `messages-stack` 与
  滚动容器之间的内容偏移会影响锚点捕获（capture 已用内容坐标系偏移，不受
  影响，但新增的顶部提示条若高于 120px 会进入加载哨兵上边距，见 KNOWN_RISKS）。

## KNOWN_RISKS

- **加载哨兵上边距（120px）与顶部提示条**：滚动位置落在距顶 120px 内会触发
  `loadOlder` 前置补偿；补偿现在精确（首条目 start 增量），但 useChat 的
  loadingOlder 状态在极端负载下可能长时间为 true（加载提示常驻）。测试基线已
  选在 120px 之外规避；真实用户在列表顶部阅读时仍有该既有行为。
- **锚点消息被撤回/删除**：恢复时锚点消息不存在则回到顶部（有单测覆盖）；
  不做更复杂的就近恢复。
- **锚定保持期的开销**：保持期内每次提交做一次 findIndex + querySelector +
  两次 getBoundingClientRect；消息量在万级、且用户长时间不滚动时是 O(n) 扫描，
  可优化为 index 缓存（当前聊天规模无压力）。
- **原生 scroll anchoring**：Chrome 的原生滚动锚定与虚拟列表 transform 布局
  偶有 ±几像素的微小调整（实测 ≤ 5px），在 e2e 60px 断言窗口内，未发现
  需要 App 侧处理的情形。
- **CI 环境差异**：本机验证为 Windows + Node 24；CI 若在 linux 容器跑 e2e，
  建议先单独确认 navigation 套件（依赖 Playwright 浏览器与 better-sqlite3
  预编译）。
