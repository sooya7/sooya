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
