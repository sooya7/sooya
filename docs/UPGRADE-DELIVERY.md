# SOOYA 核心升级稳定化修复 — 交付文档

> 交付分支：`upgrade/core-systems-stabilization`
> 代码交付版本：`7962eb3`（2026-08-08）
> 交付文档版本：`6e3bc69`
> 最终验收版本：待最终 HEAD 与 GitHub CI 确认后填写（见文末 READY TO MERGE 记录）
> 依据：《SOOYA 核心升级稳定化修复方案》（`docs/UPGRADE-STABILIZATION-PLAN.md`）+ 实施稿 `sooya-upgraded-src.zip`
> 基线：`main`（`319a36c`）

---

## 1. 交付概要

本次交付把「可打断回复与连续消息合并」「独立自然语音系统」「Life V2 连续生活系统」三大升级从**实现稿**（未运行、不可编译）修复到**可编译、可测试、可运行、全部门禁通过**，并补齐了方案 P1 的功能闭环：

- 实现稿导入后存在 35 处以上编译错误与运行时缺陷，本次全部修复；
- 按方案 P0 → P1 逐模块推进，每个独立模块一次提交（共 11 个提交）；
- 最终门禁：typecheck 0 error、server 测试 591/591、web 测试 444/444、build 成功、E2E 84/84。

---

## 2. 分支与提交记录

```
7962eb3 fix(web): restore quote-preview suppression by previousId; align reply.failed tests
beac257 docs(upgrade): record stabilization status and gate results
fa47036 test(e2e): align voice, TTS fallback and model-failure scenarios with the new pipeline
c58949c fix(reply): atomic shell/events and durable completion; align stream/atomicity tests
2d0095a refactor(proactive): route proactive voice through VoiceService; cancel when the user appears
4c8bad0 fix(core): close gaps the test suites surfaced
c690b78 fix(life): correct vitals, plan lifecycle, timezone scheduling; make plans/threads executable
bf7bbdd fix(voice): pass reply context into scripts; wire cancel, fencing, hidden-draft replace
b5c484c fix(reply): close batch state transitions and retry races
bbfae46 fix(db): repair v15-v17 migrations
0865f80 chore(upgrade): import staged core upgrade implementation
dac1e46 docs: add core upgrade stabilization plan          ← 分支起点（远程原有）
```

---

## 3. 方案完成情况

### P0-A 编译与接口一致性 — 完成

| 项 | 状态 | 说明 |
|---|---|---|
| A1 migrations 语法 | ✅ | v15/v16/v17 缺失逗号修复，typecheck 0 error |
| A2 `markQueued` | ✅ | collecting→queued 原子转换，barrier/revision 围栏 |
| A3 `debounceMs` 清理 | ✅ | 统一 `initialDebounceMs/interruptDebounceMs/maxCollectionMs/publishGraceMs`，测试 seam 在 app 层转换 |
| A4 `LifeRuntime` 接口 | ✅ | ContextBuilder/ProactiveComposer/jobs 不再写死 `LifeEngine` |

### P0-B 可打断回复状态机 — 完成

| 项 | 状态 | 说明 |
|---|---|---|
| B1 timeout retry | ✅ | 新增事务化 `prepareRetry`（generating→queued+retry_count+清 lease），独立 retry AbortController 可中止退避，**重试真正二次发起 provider 调用**；自动重试上限 1 次 |
| B2 partial 状态顺序 | ✅ | 已发布内容失败 → 直接 `publishing→completed(partial)`，不再先 fail 再 complete；provider 错误只进 generation audit |
| B3 后处理解耦 | ✅ | memory/push/summary/life bridge 全部为独立 durable jobs（新增 `life.conversation` job，带 revision 围栏）；回复完成后永不重跑模型 |
| B4 竞态测试 | ✅ | reply-coordinator 测试重写：debounce/maxCollection/重复消息/中断/timeout 重试/partial/stale revision/重启恢复/发布竞态，10/10 |

### P0-C 语音正确性 — 完成

| 项 | 状态 | 说明 |
|---|---|---|
| C1 脚本上下文 | ✅ | prompt 真实嵌入【用户本轮内容】【已确定回复内容】【语音模式】，禁止编造事实 |
| C2 意图语义 | ✅ | read_aloud/replace/complement/summary 四模式独立；`[[voice]]` 合并指令语义删除 |
| C3 cancel | ✅ | `cancel(id)` 中止真正传给 TTS provider 的信号；用户取消记为 `cancelled`，与 superseded 区分 |
| C4 revision fencing | ✅ | media.save 前与发布前重新校验 batch revision，旧 TTS 晚返回不挂载 |
| C5 replace 发布 | ✅ | 用户指令驱动（用语音回我/只发语音）走 hidden-draft：音频成功前不出现气泡、文字永不先显后消；TTS 失败发布完整文字回退 |

### P1-A 语音自然度 — 完成

- D1 spokenText/synthesisText 分离：transcript 永远保存完整脚本，合成按 maxChars 裁剪；协议标记（`[[voice]]` 等）不泄漏进存储文案。
- D2 Naturalness Guard 全项生效：相似度/句长/报告腔/语气词密度/重复开头/Markdown/预计时长，不合格重写一次→规则降级（replace 降级不丢内容）。
- D3 Delivery Plan 真正消费：pace→speed、pause/emphasis 编译进 instructions；用户保存的情绪映射（voice.emotions）优先，默认映射由 delivery plan 驱动。
- D4 Feature Flags 全部接入：`VOICE_INDEPENDENT_SCRIPT/NATURALNESS_GUARD/ADVANCED_DELIVERY/AUTO_COMPLEMENT/READ_ALOUD/TTS_RETRIES` 逐项生效；未使用的 `VOICE_LIFE_SHARE_ENABLED` 已删除。

### P1-B Life V2 闭环 — 完成

- E1 睡眠 Vitals：settle 按 `life_state.kind` 漂移——睡觉恢复 energy、偿还 sleep_debt、hunger 缓慢上升；不再"越睡越累"；routine 活动真正应用 `KIND_VITAL_EFFECTS`。
- E2 Conversation Plan 可执行：建议文本可映射活动库（activityId），无法映射保留受约束 freeformIntent + tags；无法安全解析保持 planned，不假装完成。
- E3 Plan 生命周期闭环：`life_state.meta` 记录 source/activityId/planId/threadId；活动结束 plan→completed（写 outcomeId/outcome/completedAt）；窗口错过→skipped。
- E4 Thread 创建来源：activity outcome follow-up、conversation 建议、admin API（`POST /api/admin/life/threads`）、persona 兴趣种子；活跃 thread 上限 3。
- E5 时区：新增 `localDateTimeToUtc/localDateOfIso/weekdayOfLocalDate`，引擎本地时间走 IANA 时区；删除 `startsWith(localDate)` 对 UTC ISO 的比较。
- E6 Continuity：bestScored 传入真实因果上下文（上一活动 follow-up hooks/tags/outcome、thread 关联活动），买菜→做饭等获得评分加成。

### P1-C 主动消息统一

- ✅ 主动消息冲突保护 — 完成：reply 批次打开时 proactive 被拒绝（`reply_in_progress`）。
- ✅ 主动语音 VoiceService 接入 — 完成（D5）：proactive voice 走 `VoiceService.synthesizeProactive`（脚本→守卫→韵律→TTS 全链路），禁止直接 `ttsProvider().synthesize()`。
- ✅ Proactive Coordinator 统一调度 — 完成（F1/P0-1）：`ReplyCoordinator.enqueueProactive(task)` 统一调度，用户消息永远优先——队列中的 proactive 立即取消，运行中的 proactive（chat/TTS/image 生成中）底层 AbortSignal 真正触发；未发布即丢弃、已发布不撤回。
- ✅ Proactive 发布幂等 — 完成（P1-4）：migration v18 对 `proactive_attempts(candidate_id) WHERE status='sent'` 加部分唯一索引；attempt 与消息同事务落定，并发重复发送被约束拒绝（`candidate_already_sent`）。

---

## 4. 用户可感知的行为变化

1. **回复合并**：连续发多条消息 → 只回复一次；回复生成中（未显示）继续发消息 → 旧生成无痕中止并入同一批；回复已显示 → 不撤回，新消息进入下一批。
2. **失败卡片**：超时/模型错误不再写"模型响应超时了"这类角色正文，改为结构化失败卡片（附事件编号），无可见输出时自动重试 1 次。
3. **语音**：`用语音回我`/`只发语音` → 语音消息在音频就绪前不显示任何内容；TTS 失败自动回退完整文字；`读出来` → 附着原消息朗读，不产生重复气泡；语音脚本独立生成，不再复读正文。
4. **生活**：/api/life 返回 theme/vitals/plans/threads；用户建议的活动（试试 X）会真正进入日程执行；睡眠会恢复精力。

---

## 5. 修复的缺陷清单（实现稿遗留）

| 缺陷 | 影响 | 修复 |
|---|---|---|
| migrations v15-v17 缺逗号 | 无法编译 | 补逗号 |
| `markQueued` 缺失 | 收集期无法转 queued | 补原子方法 |
| timeout 重试拿空 signal、batch 停留 generating | 重试永不真正重启 | `prepareRetry` + 独立 retry controller |
| partial 先 fail 再 complete | complete 必然失败 | 先 complete(partial) |
| onCompleted 失败 requeue | 可能重跑模型产生第二条回复 | 解耦为 durable jobs |
| `recoverOpen` 不回填 assistant_message_id | 重启后已发布回复丢失关联 | 按 batch_id 回链 |
| hidden-draft 泄漏缓冲文字 | 语音回复先显文字再消失 | phase 1 门控兜底路径 |
| synthesis 未按 maxChars 裁剪 | 长文本全部合成 | 裁剪 + transcript 完整保留 |
| `[[voice]]` 标记泄漏进 transcript | 文案带协议标记 | normalize 剥离 |
| `recordUsage` 参数缺失 | 首次活动记录崩溃 | 补 updated_at 参数 |
| V2 边界双事件 + 事件-log 未链接 | markShared 失效、重复记录 | 单事件 + logId 链接 |
| 失败路径不写 error_log | 无运维线索 | 补 redacted diagnostic + incidentId |
| 前端引用块逻辑过度收紧 | 结构性 replyTo 预览全丢 | 恢复 previousId 规则 |
| `/api/messages` 契约漂移 | duplicate 语义破坏 | 恢复 replyPending/batchId 契约 |

---

## 6. 质量门禁结果

| 门禁 | 命令 | 结果 |
|---|---|---|
| 依赖安装 | `npm ci` | ✅ |
| 类型检查 | `npm run typecheck` | ✅ 0 error |
| Server 测试 | `npm test -w @sooya/server` | ✅ 本地全量通过 |
| Web 测试 | `npm test -w @sooya/web` | ✅ 本地全量通过 |
| 构建 | `npm run build` | ✅ server + web |
| E2E | `npm run test:e2e` | ✅ 本地全量通过 |
| **本地门禁** | 上述全部 | ✅ **PASS** |
| **GitHub CI** | push 后 Actions | ⏳ **PENDING**（最终 HEAD 验证后更新） |

---

## 7. 新增 / 变更的 API

| 端点 | 说明 |
|---|---|
| `POST /api/messages/sync` | 恢复同步语义：等待回复完成，返回 `reply` + `outcome` |
| `POST /api/messages` | 返回 `replyPending`/`batchId`（duplicate 语义） |
| `POST /api/reply-batches/:id/retry` | 失败/partial 批次重新生成 |
| `POST /api/admin/life/threads` | admin 创建 thread（E4） |
| `POST /api/voice-generations/:id/cancel` | 取消未发布的语音生成 |
| `GET /api/settings/voice` / `PATCH` | 语音偏好（含 quietHours 清理语义） |
| 事件 | `reply.publishing.started/partial`、`voice.plan.created`、`voice.generation.superseded`、`voice.cancelled` 等；`reply.failed` 载荷为 `{ batchId, revision, failure, message }` |

---

## 8. 部署与回滚

- 数据库迁移 v15/v16/v17 为**一次性前向迁移**（新增表/列，重建 reply_batches）；升级部署前建议先备份数据目录。
- 回滚（P0-5）：**v15 之后存在 `generating/publishing/superseded` 等新状态，旧代码不能完整处理，禁止"切回旧代码即可"。**
  - **首选（推荐）**：停止服务 → 恢复升级前的 DB backup → checkout 旧 release → 启动。
  - **保留新 DB 降代码**：必须先用 `npm run rollback:preflight` 检查（open 批次/进行中的语音与 proactive/迁移一致性），再显式执行 `npm run rollback:normalize`（`generating`+hidden→`queued`；`publishing`+visible→`completed/partial`；`publishing`+hidden→`queued`；`superseded`→`cancelled`；输出每项修改）。进行中的语音生成或 proactive 交付未清零时 normalize 拒绝执行。
  - 降级前不得残留 `generating / publishing / superseded` 状态。
- 环境变量：`VOICE_LIFE_SHARE_ENABLED` 已删除（未使用）；其余 `VOICE_*`/`REPLY_*` 开关默认值不变，可逐项关闭新管线回退（`VOICE_V2_ENABLED=false` 回退旧朗读路径，`REPLY_INTERRUPTIBLE_GENERATION=false` 回退旧非打断流程）。

---

## 9. 已知限制（非阻断）

1. 模型自动语音仅允许 `complement`/`summary`（P0-3）：模型自行输出 `[[voice-only]]` 被降级为 complement；`replace` 只由明确用户指令（只发语音/用语音回我/不要打字）触发，走 hidden-draft，不会出现文字先显后消。
2. 天气、真实地点、A/B、Shadow 模式、Life Admin 完整 UI、Voice Preferences 完整 UI 按方案标注暂缓，未实施。
3. web 测试存在 jsdom `act(...)` stderr 警告（非失败）；server 套件因串行 + harness 启动较慢（约 22 分钟）。

---

## 10. 验收建议

1. `npm ci && npm run typecheck && npm test -w @sooya/server && npm test -w @sooya/web && npm run build` 复跑全部门禁。
2. 手工验收（或 E2E）：
   - 连续发三条消息 → 只收到一条回复；
   - 回复生成中继续发消息 → 旧任务取消、合并回复；
   - 故意把模型 endpoint 配错 → 出现失败卡片 +「重新生成」；
   - `用语音回我` → 语音不是正文复读；`只发语音` → TTS 失败回退完整文字；`读出来` → 附原文朗读；
   - 对她说"试试去公园散步" → 后续 Life 日程真实执行并可回访。
