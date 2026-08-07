# SOOYA 核心升级稳定化修复方案

> 修复分支：`upgrade/core-systems-stabilization`
>
> 基线：当前 `main`。上传的 `sooya-upgraded-src.zip` 作为待移植/修复实现稿，不直接视为可发布代码。
>
> 目标：先恢复可编译、可测试、可回滚，再逐项闭合可打断回复、独立语音、Life V2 三大系统。

## 0. 发布门禁

任何功能都不得进入 main，直到同时满足：

1. `npm ci`
2. `npm run typecheck`
3. `npm test -w @sooya/server`
4. `npm test -w @sooya/web`
5. `npm run build`
6. 关键 E2E：连续三段消息、超时重试、voice reply/voice only/read aloud、Life V2 用户建议计划

---

## P0-A：先恢复编译和接口一致性

### A1. 修复 migrations.ts 语法

上传实现稿中 v15/v16/v17 migration 对象之间缺少逗号，当前 `tsc` 首先报：

- `src/db/migrations.ts:678 TS1005 ',' expected`
- `src/db/migrations.ts:772 TS1005 ',' expected`
- `src/db/migrations.ts:806 TS1005 ',' expected`

修复后必须再次运行 typecheck，继续清理后续类型错误。

### A2. ReplyBatchRepo 补齐 collecting → queued 原子转换

`ReplyCoordinator.schedule()` 调用了不存在的 `ReplyBatchRepo.markQueued()`。

新增：

```ts
markQueued(batchId: string, revision?: number): boolean
```

要求：

- 只允许 `collecting -> queued`
- 可选 revision fencing
- `visible_at IS NULL`
- 幂等，不得把 generating/publishing 拉回 queued

### A3. 删除旧 `debounceMs` 配置残留

`app.ts` 仍向新的 `ReplyCoordinatorOptions` 传入 `debounceMs: opts.replyDebounceMs`。

处理：

- 删除旧字段
- 测试全部迁移到 `initialDebounceMs / interruptDebounceMs / maxCollectionMs / publishGraceMs`
- 旧 CLI/test seam 如需兼容，应在 app 层转换，不污染 Coordinator 新接口

### A4. 抽出 Life 运行时接口

`ContextBuilder` 与 `ProactiveComposer` 仍写死 `LifeEngine` 类型，但 app 可能注入 `LifeSimEngine`。

新增最小共享接口，例如：

```ts
export interface LifeRuntime {
  tick(): LifeTickResult | LifeSimResult;
  contextLines(lastUserMessageAt?: Date | null): string[];
  shouldReachOut(lastUserMessageAt: Date | null, lastAssistantMessageAt: Date | null): ProactiveDecision;
}
```

Life V2 独有接口通过 capability/窄化处理，不要求旧 LifeEngine 实现 V2 方法。

---

## P0-B：修复可打断回复状态机

### B1. 修复 timeout retry 实际不会启动的问题

当前 catch 前会从 `activeGenerations` 删除 active generation；随后 retry delay 取得的是空 signal，而且 batch 仍停留在 `generating`，`startGeneration()` 又要求 `queued`，因此重试不会真正 claim。

推荐新增事务方法：

```ts
prepareRetry(batchId, revision, owner): ReplyBatchRow | undefined
```

一次完成：

- 校验 `status='generating'`
- 校验 revision + lease_owner
- `retry_count += 1`
- `status='queued'`
- 清 lease

然后使用独立 retry AbortController 进行可取消退避，再 `startGeneration()`。

### B2. 修复已发布 partial 失败的状态顺序

当前逻辑先 `fail()` 把 batch 变成 failed，再调用只接受 publishing 的 `complete(...partial=true)`，后者必然失败。

正确规则：

- `active.published === true`：保留已发布内容，直接 `publishing -> completed(partial=1)`
- 不再把同一 batch 标为 failed
- 单独记录 generation failure/audit
- UI 发 `reply.publishing.partial`，可提供继续生成

### B3. 后处理 onCompleted 不得反向重跑回复

当前 reply 已 complete 后，`onCompleted` 失败再尝试 fail/requeue 无法命中状态，也不应重跑模型。

改为：

- 回复完成事务先落定
- memory/push/summary/life bridge 使用独立 durable jobs
- 后处理失败只重试对应 job
- 永远不因为 push/memory 失败重新生成聊天正文

### B4. 中断竞态测试

必须覆盖：

- generating 隐藏阶段新消息
- beginPublishing 与新消息同毫秒竞争
- abort 后 provider 晚返回
- 连续 3~5 次 interrupt
- duplicate client message 不 bump revision
- publishing 后新消息创建 next batch

---

## P0-C：修复 Voice V2 核心正确性

### C1. VoiceScriptGenerator 必须真的拿到原回复

当前 `generateScript(text, mode, userText, ...)` 的 prompt 没包含 `text`，`userText` 也未使用。

必须至少输入：

```text
【用户这轮说的话】
...

【你已经确定的回复内容】
...

【语音模式】
...
```

并要求：

- 事实只能来自最终回复/可信上下文
- complement 不重复正文
- replace 保持完整回答
- summary 不遗漏主结论

### C2. 删除旧“语音=复读文字”的系统提示

删除：

```text
[[voice]] 把这条文字同时用语音发出来。
```

新的 prompt 明确区分：

- `read_aloud`：朗读
- `replace`：独立口语回答
- `complement`：语音补充温度/态度
- `summary`：长正文口语摘要

主模型不再被教成先写正文再朗读。

### C3. 修复 Voice cancel signal

当前 inline voice 把一个 controller 存进 `active`，实际 TTS 却使用另一个 `combined.signal`；`cancel(id)` 中止不到真正的 TTS。

改为：

- `active` 存真正传给 provider 的 controller
- 或统一使用 `combineAbortSignals([replySignal, manualCancel.signal, timeoutSignal])`
- cancel 后 `voice_generation.status='cancelled'`
- superseded 与 user-cancel 分开

### C4. 发布前加 revision fencing

在 media.save 和 appendPart 前再次确认：

- batch 仍是当前 revision
- replace 尚未被 superseded
- assistant message 仍有效

禁止旧 TTS 晚返回后挂到新回复上。

### C5. replace 发布语义

目标：音频成功前不出现空 assistant bubble。

短期实现可接受：

- reply shell 处于 hidden/draft 状态
- TTS 成功后一次发布 audio
- TTS 失败时发布 spokenText 文字 fallback

不得出现“先看到文字，随后文字突然消失”的明显跳变。

---

## P1-A：完成语音自然度系统

### D1. spokenText 与 displayText 真正分离

TTS 永远使用 `synthesisText`，transcript 永远保存真实 `spokenText`。

### D2. Naturalness Guard

至少检查：

- complement 与正文 n-gram/Jaccard 相似度
- 平均句长/最长句长
- Markdown 残留
- 报告腔词组
- 语气词密度
- 重复开头
- 预计时长

不合格最多重写一次。

### D3. Delivery Plan 真正消费

当前 energy/warmth/intimacy/openingStyle 等不能只停留在 JSON。

实现 provider adapter：

- provider 支持时直接映射
- 不支持时编译成更具体的 instructions
- `pace` 映射 speed
- emotion preset 只是 fallback，不覆盖完整 delivery instructions

### D4. Feature Flags 真正生效

逐项接入：

- `VOICE_INDEPENDENT_SCRIPT_ENABLED`
- `VOICE_NATURALNESS_GUARD_ENABLED`
- `VOICE_ADVANCED_DELIVERY_ENABLED`
- `VOICE_AUTO_COMPLEMENT_ENABLED`
- `VOICE_LIFE_SHARE_ENABLED`
- `VOICE_READ_ALOUD_ENABLED`
- `VOICE_TTS_RETRIES`

未接入的 flag 删除，避免“配置存在但没作用”。

### D5. Proactive voice 迁入 VoiceService

禁止继续：

```ts
ttsProvider().synthesize(text)
```

主动消息统一走：

`LifeShareCandidate -> VoicePresentationPlanner -> VoiceScriptGenerator -> Guard -> Delivery -> TTS`

---

## P1-B：闭合 Life V2

### E1. 修复睡眠 Vitals

当前 settle() 无条件降低 energy，且 `KIND_VITAL_EFFECTS.sleep` 未实际应用；睡觉可能越睡越累。

推荐：

- settle 根据当前 life_state.kind 做不同 drift
- sleep：energy 上升、sleep_debt 下降、hunger 缓慢上升
- awake：energy 下降、hunger 上升
- 删除未使用的 KIND_VITAL_EFFECTS，或把它真正用于基础 routine activity completion

### E2. 用户建议计划必须可执行

conversation plan 当前没有 `meta.activityId`，但 scheduler 只通过 activityId 找定义。

不能粗暴把任意用户建议塞到固定 activityId。

新增 `LifePlanAction`：

```ts
{
  activityId?: string;
  freeformIntent?: string;
  tags?: string[];
  locationType?: string;
}
```

执行时：

1. 已映射 activityId -> 正常活动库
2. freeformIntent -> 受约束生成/选择 compatible activity
3. 无法安全解析 -> 保留 planned，不假装完成

### E3. Plan 生命周期闭环

当前开始 theme plan 后 `planId` 没进入 life_state.meta，完成活动时无法把 plan 标 completed。

修复：

```ts
life_state.meta = {
  source,
  activityId,
  planId,
  threadId
}
```

finishActivity：

- active plan -> completed
- 被中断 -> paused/delayed
- 超出窗口 -> skipped/delayed
- 写 outcomeId/completedAt

### E4. Thread 创建入口

当前主要只有表、repo、推进逻辑，没有自然创建来源。

新增来源：

- persona seed interests
- activity outcome follow-up hook
- conversation bridge
- admin API

限制同时 active threads 数量，建议 1~3。

### E5. 修复时区计算

禁止用“localDate + Z + offset”的方式构造本地时间。

统一通过 time-zone util：

```ts
localDateTimeToUtc(localDate, hour, minute, timeZone)
```

所有“今天计划”判断使用 local date helper，不再对 UTC ISO 使用 `startsWith(localDate)`。

### E6. 连续性评分

`continuityFrom` 当前为空数组，真正把上一活动 tags/outcome/thread 传入 selector。

这样：

- 买菜 -> 做饭获得 bonus
- 看教程 -> 实践获得 bonus
- 下雨回家 -> 热饮/洗澡获得 bonus

---

## P1-C：主动消息统一调度

### F1. Proactive 迁入 Coordinator

实施报告已承认主动消息仍由 `ProactiveComposer` 直写。

目标接口：

```ts
replyCoordinator.enqueueProactive(candidate)
```

规则：

- 用户消息永远优先
- collecting/queued/generating/publishing 时主动消息不启动
- 等待期间用户出现 -> 取消 proactive
- proactive 也使用自己的 generation id/revision
- 同一 share candidate 只能成功发布一次

### F2. 主动多媒体统一 PresentationPlan

主动文字、语音、表情、图片不再各自直接写 message。

全部走统一 publication pipeline。

---

## P2：管理、天气、地点和观测

这些不是当前上线阻断项，在 P0/P1 全绿后再做：

1. Weather Snapshot
2. Location model
3. Admin Life panel
4. Voice preferences UI
5. Shadow/A-B
6. diversity/naturalness metrics dashboard

---

## 测试补齐

### Reply

- debounce 200ms
- interrupt 300ms
- grace 600ms
- max collection 4000ms
- stale revision
- timeout retry 真正发起第二次 provider call
- partial completion
- restart recovery

### Voice

- 四种 intent
- script prompt 包含原回复
- complement similarity
- report-style rejection
- cancel 真正中止 provider
- stale revision 音频丢弃
- replace failure fallback
- proactive voice 不复读

### Life

- sleep 恢复 energy
- hunger/energy drift
- local timezone day plan
- conversation plan 真正执行
- plan active -> completed
- thread create -> advance -> resolve
- semantic anti-repeat 14 天模拟
- proactive conflict protection

### E2E

必须至少覆盖：

1. 连续发三段，最终一条回复
2. generation 中再发消息，旧请求 abort
3. 模型第一次 timeout、第二次成功
4. timeout 两次只显示一张失败卡
5. “用语音回我”不朗读正文
6. “只发语音”失败时文字 fallback
7. “读出来”附着原消息，不重复气泡
8. 用户建议一个活动，后续 Life 真正执行并可回访

---

## 推荐 commit 顺序

1. `chore(upgrade): import staged core upgrade implementation`
2. `fix(db): repair v15-v17 migrations`
3. `fix(reply): close batch state transitions and retry races`
4. `test(reply): cover interrupt retry partial and recovery`
5. `fix(voice): pass reply context into independent voice scripts`
6. `fix(voice): wire cancellation revision fencing and prompt semantics`
7. `test(voice): cover intent naturalness cancel and fallback`
8. `fix(life): correct vitals plan lifecycle and timezone scheduling`
9. `feat(life): make conversation plans and threads executable`
10. `test(life): cover vitals plans threads and anti-repeat`
11. `refactor(proactive): route proactive delivery through coordinator`
12. `test(e2e): cover combined reply voice and life flows`
13. `docs(upgrade): update implementation status and rollout checklist`

---

## 完成定义

### P0 完成

- typecheck 0 error
- server tests 全绿
- web tests 全绿
- build 成功
- 连续消息/超时/voice-only 基本场景可用

### P1 完成

- 独立语音不再复读正文
- Life 用户建议可真实执行
- plan/thread 生命周期闭环
- proactive 不与用户回复竞争
- 新三系统核心 E2E 全绿

### 可合并 main

只有当 P0 + P1 全部满足，并且 CI 在该分支 HEAD 上全绿后才允许合并。