# E2E 问题记录：返回聊天时滚动位置恢复在 mobile 上失败

> 记录时间：2026-08-08
> 分支：`upgrade/world-context-admin-experiments`
> 影响范围：`e2e/navigation.e2e.ts:39`「returning to chat restores a history-reading scroll position」
> 性质：**既有问题**（main 分支同样可复现），非本阶段引入；本阶段 CI 以 `retries=1` 兜底

---

## 1. 现象

- 完整 e2e suite（desktop → mobile 顺序）中，该测试在 **mobile**（Pixel 7）上稳定失败；
- 单独运行 `--project=mobile -g "returning to chat"` 时通过；
- 失败断言：`expect(Math.abs(after - before)).toBeLessThan(60)`，实测差值为 **205px**；
- 关键数值（插桩获得）：

```text
before = 2784   // 导航离开前，settle 后的滚动位置（当时是底部）
after  = 2579   // 返回后，settle 后的滚动位置
max    = 4096   // 返回后 scrollHeight - clientHeight
msgs   = 27     // DOM 中消息数（20 条 API 发送 + 7 条回复管道消息）
```

- 同一测试在 desktop 上通过（`before=894, after=894`）。

## 2. 复现条件

| 条件 | 结果 |
|---|---|
| 完整 suite（desktop 先跑）→ mobile | 稳定失败（多轮 100%） |
| 单独跑 mobile | 稳定通过 |
| main 分支（重建 dist 后） | 同样失败（4/4 中该测试失败） |

结论：与**机器负载/运行顺序**强相关，不依赖本分支任何功能改动。

## 3. 根因分析

测试流程：API 发 20 条用户消息 → 打开聊天页 → 手动 `scrollTop = 40` → 去管理页 → 返回 → 断言位置差 < 60px。

实际数据链条：

1. **回复管道介入**：20 条 API 消息触发回复管道，生成 7 条助手消息（SSE 推送到页面），共 27 条；
2. **虚拟化列表的估算→测量校正级联**：消息高度先按 `estimateSize` 估算，渲染后再经 ResizeObserver 实测校正。校正会持续 1 秒以上（本机负载下更久），期间 `scrollHeight` 从 ~3510 增长到 ~4096（+586px ≈ 多条消息高度）；
3. **恢复时机竞态**：聊天页从管理页返回时（`ChatView` 重挂载，`active` 切换），非 stickToBottom 模式走 `restoredScrollTop()`：

   ```ts
   return Math.min(maximum, Math.max(0, state.scrollTop));  // maximum = scrollHeight - clientHeight
   ```

   此时列表尚未完成布局（`scrollHeight` 仍为部分值），`min()` 把恢复位置钳制到**部分 max**（2579），而不是目标 2784；
4. **无修正机制**：恢复后 `stickToBottomRef` 为 false（用户手动滚动过），ResizeObserver 不再 pin，位置丢失 205px 且不再恢复。

## 4. 已尝试的修复（均未完全解决，已回退）

| 方案 | 内容 | 结果 |
|---|---|---|
| 测试侧 settle 谓词 | 基线采集前要求 `scrollTop / scrollHeight / 消息数` 三重稳定 1.2s；返回后同样 settle | desktop 稳定；mobile 在 suite 下仍失败 |
| App 侧恢复重试 | 恢复后逐帧重试 `scrollTop = min(max, desired)`，直到布局收敛（rAF 预算 60 → 300 帧） | 单独跑通过；suite 下 mobile 仍失败（测量级联在本机负载下 > 300 帧 ≈ 5s 仍未收敛） |

两个方案方向正确但都依赖布局收敛速度，本机负载下不可靠。**已全部回退**，分支保留原始行为。

## 5. 结论与建议

- 这是**虚拟化列表滚动恢复的既有缺陷**（恢复早于布局完成），不是本阶段功能引入的问题；
- 短期：以 CI 配置 `retries=1` 跑全量 e2e 门禁（与该测试在合并前 CI 中的待遇一致）；文档记录已知 flake；
- 中期建议（后续独立修复，不阻塞本阶段）：
  1. 恢复路径改用 `virtualizer` 的偏移计算（对未渲染条目可用估算位置），或在恢复后监听首次布局稳定再校正一次；
  2. 或在测试中显式等待 SSE 回复管道结束（等 `chat.messages` 稳定）后再采集基线；
  3. 考虑在 mobile 项目上为该测试加 `retries` 或缩小断言窗口。

## 6. 相关代码位置

- `packages/web/src/App.tsx` — `useLayoutEffect` 初始滚动恢复块（stickToBottom=false 分支）
- `packages/web/src/lib/chatViewState.ts` — `restoredScrollTop()`（`min(max, target)` 钳制逻辑）
- `e2e/navigation.e2e.ts:39` — 受影响测试

---

## 7. 已修复（2026-08-07，分支 `agent/scroll-anchor`）

> 上述 1-6 节保留为历史分析。本阶段（滚动恢复结构性修复）已完成锚点模型
> 重构，`e2e/navigation.e2e.ts` 的滚动恢复测试在 **retries=0** 下
> desktop + mobile 连续 6 轮全部通过（每轮 4/4，共 24/24 次通过）。

### 7.1 根因（补充实测）

- 除原分析外，插桩还确认了三条独立的竞态/缺陷：
  1. **基线采集时机**：SSE 回复管道与「估算 → 实测」级联在首帧后持续数秒，
     且存在 >2.5s 的静默间隙；`scrollTop=40` 落在加载哨兵 120px 上边距内，
     触发 `loadOlder` 的前置补偿（`scrollTop += totalSize 差值`，混入无关条目
     测高校正，过冲可达数百像素）——测试基线被 App 自身滚动机制冲走；
  2. **锚点捕获偏移错误**（App 侧真实缺陷）：卸载捕获用
     `stack.top - scroller.top` 作为内容偏移，但该 rect 差值已包含
     `-scrollTop`（实测 -289 而非 13），导致锚点选到视口下方约一屏的条目；
  3. **锚定锁被自身滚动误释放**：恢复路径的 `scrollToIndex` 与修正滚动都会
     触发 scroll 事件，原「偏离目标即视为用户接管」的判断会把锁提前释放，
     级联后续测量不再修正。

### 7.2 方案（anchor-based restore）

- `ChatViewState` 改为 `{ anchor: ChatScrollAnchor | null; stickToBottom: boolean }`，
  `ChatScrollAnchor = { messageId; offsetFromViewportTop }`（`lib/chatViewState.ts`）；
- 离开时：取视口顶部第一条可见消息为锚点，保存其 messageId 与顶边到视口顶部的偏移；
- 返回时：`virtualizer.scrollToIndex(anchorIndex, { align: 'start' })` → 锚定保持期内
  每次提交按锚点 DOM 实测位置 `scrollTop += (当前顶边 - 目标偏移)` 修正，直到
  测量级联收敛；不用绝对 scrollTop、不用固定 sleep、不用 rAF 帧数预算；
- 锚定保持期只被真实手势（wheel/pointer/touch）或贴底解除；恢复窗口内自身
  scrollToIndex/修正滚动不会释放锁（`restoreInProgress`）；
- `loadOlder` 前置补偿改为按首个渲染条目 `start` 增量滚动（精确的前置高度，
  不受其他条目测高校正干扰）；
- 保留行为不变：stickToBottom（新消息贴底）、初次打开滚到底部、历史工具跳转。

### 7.3 测试改进（仅测试侧时序，未加宽断言）

- 基线采集前等待 scrollTop/scrollHeight/消息数三重稳定（settle 谓词），
  位置设在加载哨兵上边距之外（300px）并二次确认；
- 断言不变（`|after - before| < 60`），另追加锚点契约断言：
  返回后视口顶部消息 id 相同、顶边偏移差 < 60px。

### 7.4 验证数据

- web 单测：36 文件 457 用例全通过（含新增 `App.anchorRestore.test.tsx` 8 用例：
  恢复修正、前方高度变化级联、SSE 追加、锚点自身高度变化、手势解除锚定、
  锚点缺失回顶、卸载捕获）；
- e2e：`npx playwright test navigation --retries=0` 连续 6 轮全绿
  （desktop + mobile，每轮 4/4）：
  `ok 2 desktop returning-to-chat … 24.5s` / `ok 4 mobile … 24.4-24.8s`；
- 插桩实测：before=300 → after=300（diff=0），锚点消息 id 与偏移（-29）完全一致。

### 7.5 相关代码位置（修复后）

- `packages/web/src/lib/chatViewState.ts` — `ChatScrollAnchor`/`captureChatViewState`/
  `anchorScrollCorrection`/`isAnchorSettled`
- `packages/web/src/App.tsx` — 卸载捕获、初始恢复（`scrollToIndex` + 锚定修正）、
  `loadOlder` 补偿、手势解除锚定
- `e2e/navigation.e2e.ts` — settle 谓词与锚点断言
