# SOOYA 核心升级实施报告

> 依据 `sooya_core_interaction_life_voice_system_plan.txt`（v1.0 总方案）实施的三大系统升级。
> 代码已全部落盘，**未在本环境运行**（沙箱无 Node.js），需要你在本地执行验证步骤（见文末）。

---

## 一、可打断回复与连续消息合并（方案第一部分，完整实施）

### 行为变化
- 首条消息 **200ms** 后开始请求模型；回复显示前新消息到达 → 无痕中止旧生成、并入同一批、**300ms** 后重新生成；回复已显示 → 不撤回，新消息进入下一批。
- 发布保护期 **600ms**：期间模型输出只缓存在内存，屏障打开后才创建 assistant 消息并显示（**不再提前创建可见 shell**）。
- 超时不再写入角色正文（删除「模型响应超时了」气泡），改为结构化失败卡片 + 「重新生成」按钮；无可见输出时自动重试 1 次（可中止退避）。
- 多条自动合并的消息不显示引用卡（`replyMode: 'auto-batch'`）；只有用户显式引用才展示（`replyMode: 'explicit'`）。
- 部分输出后中断 → 保留正文并标记 partial，可手动继续生成。

### 关键文件
| 文件 | 变更 |
|---|---|
| `db/migrations.ts` | v15：reply_batches 重建（新状态 collecting/queued/**generating/publishing/completed/superseded**/failed/cancelled + revision/visible_at/retry_count/interrupted_count 等列）+ `reply_generations` 审计表 |
| `db/repos/reply-batch.repo.ts` | 重写：`appendOrCreateMessage`（事务内裁决 created/appended/interrupt/next_batch）、`beginGenerating`/`beginPublishing`/`complete`/`fail`/`retry`/`incrementRetry`/`recordGeneration`，全部带 revision 围栏 |
| `core/reply-coordinator.ts` | 重写：`onMessageAccepted`、activeGenerations + AbortController、发布屏障、超时重试、`retryBatch`、重启恢复（generating→queued 同 revision 重跑；publishing 有可见正文→completed/partial） |
| `core/replier.ts` | 拆分为 `generateText`（屏障 + 缓冲 + 流式持久化）与 `publishGeneratedReply`（延迟建 shell + 贴纸/图片/语音），引用规则 §20 |
| `util/abort.ts`（新） | `combineAbortSignals` / `abortableDelay` / `UserInterruptedError` / `StaleGenerationError` |
| `util/http.ts` | `safeFetch` 支持外部 signal，外部取消原因不被转成超时；`withRetry` 可中止退避 |
| `routes/chat.ts` | POST /api/messages 走 `appendOrCreateMessage` + `onMessageAccepted`；新增 `POST /api/reply-batches/:id/retry` |
| `core/types.ts` | 新 SSE 事件类型 + `ReplyFailure` |
| `config/env.ts` / `.env.example` | `REPLY_*`、`CHAT_*` 参数 |
| Web | `lib/stream.ts`、`lib/useChat.ts`（批次状态「正在听你说/正在思考/正在回复」、失败卡片、revision 防旧事件）、`lib/api.ts`（retryBatch）、`App.tsx`（失败卡片 UI）、`components/MessageItem.tsx`（引用卡仅 explicit）、`styles.css` |

---

## 二、独立语音表达系统（方案第四部分，完整实施）

### 行为变化
- 语音不再是正文复读：`VoiceIntentParser` 区分 朗读（read_aloud）/ 语音回答（voice_reply → replace）/ 只发语音（voice_only → replace）/ 不要语音，能力问题不触发。
- 四种表达模式：`replace`（语音独立承担回答，成功后隐藏文字，失败回退 spokenText 文字）、`complement`（文字为主 + 语音补温度）、`summary`（长正文 + 口语摘要，前端显示「语音摘要」标签）、`read_aloud`（附着到文字气泡的「朗读」按钮，不产生第二条消息）。
- 独立口语脚本：由聊天模型二次生成（提示词含人物口语风格与模式要求），无模型时规则化降级；自然度守卫（正文相似度 n-gram+最长公共子串、平均/最大句长、正式短语、语气词密度、Markdown 残留、时长上限）不合格重写一次，再不合格按模式降级。
- 韵律规划：8 种情绪 → `VoiceDeliveryPlan`（pace/energy/warmth/intimacy/seriousness/开头结尾风格/停顿/重音/instructions）→ 映射到 TTS（pace→speed、emotion、instructions）。
- 归一化：transcript 保存真实 `spokenText`，送入 TTS 的是清理后的 `synthesisText`（去 Markdown/列表/URL/多余省略号、超长句断句）。
- 与回复系统整合：voice_generations 绑定 batchId+revision，superseded 即中止 TTS；音频保存前校验 revision；replace 在音频成功前消息不可见。
- 成本控制：默认不自动语音；自动语音仅情绪线索 + 每日上限（`VOICE_DAILY_AUTO_CAP`）；单条时长上限来自人物口语风格。

### 关键文件
| 文件 | 变更 |
|---|---|
| `db/migrations.ts` | v16：`voice_generations` 全生命周期表 |
| `db/repos/voice.repo.ts`（新） | 状态机 planned/scripted/synthesizing/published/superseded/failed/cancelled + 恢复 |
| `core/voice/types.ts`（新） | VoiceIntent / VoiceMode / VoiceDeliveryPlan / VoiceScript / UserVoicePreferences 等 |
| `core/voice/intent.ts`（新） | 规则意图解析 |
| `core/voice/planner.ts`（新） | 模式决策 + 自动语音评分（§96-97） |
| `core/voice/script.ts` → 并入 `service.ts` | 脚本生成（LLM + 规则兜底 + 重写一次） |
| `core/voice/naturalness.ts`（新） | 相似度 / 句长 / 报告腔 / 语气词 / Markdown 检测 |
| `core/voice/normalize.ts`（新） | spokenText ↔ synthesisText 归一化 + 规则口语化 |
| `core/voice/delivery.ts`（新） | 情绪 → 表达计划 → TTS 选项降级映射 |
| `core/voice/style.ts`（新） | 人物口语风格配置与提示词渲染 |
| `core/voice/service.ts`（新） | VoiceService 门面：脚本→守卫→合成→按模式发布/降级，readAloud/retryVoice/cancel |
| `routes/voice.ts`（新） | `/api/messages/:id/read-aloud`、`/voice/retry`、`/api/voice-generations/:id/cancel`、`/api/settings/voice` GET/PATCH |
| `core/replier.ts` | 3c 段接入 VoiceService（`VOICE_V2_ENABLED=false` 时走旧朗读路径） |
| Web | AudioBubble 模式标签、MessageItem「朗读」按钮、voice 事件 |

---

## 三、生活系统升级（方案第二部分，完整实施）

### 行为变化
- 连续 Vitals：energy/hunger/stress/social_need/loneliness/curiosity/comfort/focus/sleep_debt，惰性结算（读取时按流逝时间漂移，不依赖 tick），活动与对话影响状态（睡眠债、对话桥接）。
- 每日主题（8 类主题池、7 天冷却、睡眠债/周末/精力因素）+ 每日 2-3 个计划（主题驱动生成，用户建议计划高优先级）。
- 活动库 + 评分选择：17 个活动定义（时长区间/时间窗口/体力需求/效果/可能结果/后续钩子），评分 = 基础权重 + 时间适配 + 需求适配 + 连续性 + 主题适配 + 故事线适配 − 精确/语义防重复 − 冷却，控制随机只破平局。
- 防重复：`life_activity_usage` 记录使用次数/连续天数/语义标签，24h/3d/7d 惩罚 + 标签 Jaccard 语义惩罚；故事线相关活动豁免。
- 计划偏离：高优先级用户计划窗口内执行，否则评分活动自由选择；活动结果（normal/pleasant/disappointing/…）记录事件 + 体力效果 + 分享候选。
- 临时事件：条件触发（外出→天气、整理→找到东西、园艺→新芽…），tiny 等级每天 0-3 次。
- 故事线 Life Threads：热度衰减、相关活动推进（progress/heat），完成可 resolve。
- 分享候选 + 评分：事件结果/计划完成/故事线进展 → pending 候选，主动消息优先消费；主动消息在回复批次进行中一律暂缓（§50.4）。
- 对话桥接：回复完成后（仅最终 revision）从用户消息提取「建议/推荐/试试 X」→ 生成 conversation 计划；对话温暖度影响 Vitals。
- 上下文注入升级：时间/当前活动时长/主题/身体状态/今日计划/最近事件/故事线/用户约定，带事实置信度措辞。

### 关键文件
| 文件 | 变更 |
|---|---|
| `db/migrations.ts` | v17：life_vitals / life_day_themes / life_threads / life_activity_usage / life_share_candidates + life_plans、life_events 扩展列 |
| `db/repos/life-v2.repo.ts`（新） | 五张新表的 CRUD + 使用统计 |
| `core/life2/vitals.ts`（新） | Vitals 惰性结算 / 活动效果 / 对话效果 |
| `core/life2/activities.ts`（新） | 活动库 + 评分 + 防重复 + 结果池 |
| `core/life2/engine.ts`（新） | LifeSimEngine：主题/计划/优先级解析/结果/事件/故事线/分享/上下文/主动决策/快照，保持旧 LifeEngine 兼容表面 |
| `core/proactive.ts` | 新增 `reply_in_progress` 冲突保护 |
| `app.ts` | `ENABLE_LIFE_V2` 开关切换 LifeSimEngine；onCompleted 对话桥接；lifeV2 repo 装配 |
| `routes/life-admin.ts`（新） | `/api/admin/life/{vitals,themes,threads,usage,share-candidates,plans,events}` |

---

## 四、三系统统一约束（方案第三/五部分）

- 同一 `reply revision` 贯穿：语音 generation 绑定 batchId+revision；被 superseded 的 revision 不生成语音、不写生活约定（对话桥接只在 onCompleted 里跑）。
- 主动生活消息不与回复并发（`reply_in_progress` 暂缓）。
- 已发布内容（文字/音频）永不静默撤回。
- Feature Flags 全部可逐项关闭：`REPLY_INTERRUPTIBLE_GENERATION`、`ENABLE_LIFE_V2`、`VOICE_V2_ENABLED` 等（默认开启新行为）。
- 数据兼容：迁移 15-17 均向后兼容（v15 重建 reply_batches 时把旧 running→generating 并复制数据；旧状态仍在 CHECK 中保留）。

---

## 五、已知差异与限制（对照方案）

1. **计划生成**：方案建议「规则候选 + 模型 JSON 生成」，本实施为纯规则生成（主题池 → 活动库），模型生成留作后续；防重复/偏离/结果均按方案实现。
2. **主动消息入口**：仍由 ProactiveComposer 直接写消息（未迁入 ReplyCoordinator.enqueueProactive），但已加冲突暂缓；迁移到 coordinator 需要较大的重构，建议作为下一步。
3. **天气/地点系统（§53-54）**：未实施（weather=unknown 兜底、地点隐含在活动文本中）——方案本身标注为 P4 高级环境。
4. **语音 shadow 模式 / A/B（§110）**：未实施；`VOICE_*` 开关支持直接回滚。
5. **replier 的 `requestTimeoutMs`** 已传入，但 provider 层仍以各自配置的 timeoutMs 为准（45s 默认值一致）。
6. **前端**：语音偏好设置页未做（API 已就绪）；admin 面板未加生活 v2 可视化（API 已就绪）。

---

## 六、本地验证步骤（必须执行）

```bash
cd sooya
npm ci
npm run typecheck          # 期望 0 错误
npm test -w @sooya/server  # 现有单测 + 若失败请把输出发我
npm run build
npm start                  # 或 docker compose up -d --build
```

重点手工验证：
1. 连发三条消息（间隔 >300ms），只应出现一条回复；回复显示后再发消息 → 第二轮。
2. 关掉模型网络或改错 endpoint，观察失败卡片 + 「重新生成」按钮，不应出现「模型响应超时了」角色气泡。
3. 发送「用语音回我」「只发语音」「不要语音」「读出来」，观察语音气泡/文字隐藏/朗读按钮行为。
4. `/api/life` 与 `/api/bootstrap` 应返回 theme/vitals/plans/threads 新字段。
5. 打开 admin 面板检查 `/api/admin/life/*` 数据。

> 由于本环境无 Node.js，以上 typecheck/测试未能在交付前运行。若 typecheck 报错，请把错误贴回来，我立即修复。

---

## 稳定化修复完成状态（upgrade/core-systems-stabilization 分支）

> 由《UPGRADE-STABILIZATION-PLAN.md》驱动的修复已于 2026-08-07 在本分支完成，全部门禁通过。

### 完成项
- **P0-A**：migrations v15-v17 语法修复；`markQueued`/`prepareRetry` 补齐；删除 `debounceMs` 残留（统一 `initialDebounceMs/interruptDebounceMs/maxCollectionMs/publishGraceMs`）；抽出 `LifeRuntime` 接口。
- **P0-B**：timeout 自动重试真正二次发起 provider 调用（可中止退避 + 事务化 `prepareRetry`）；已发布 partial 直接 `publishing → completed(partial)` 且不再标 failed；memory/push/summary/life 后处理全部为独立 durable jobs，回复完成后永不重跑模型；中断/恢复/发布竞态测试补齐。
- **P0-C**：VoiceScriptGenerator prompt 真实嵌入用户本轮内容/已定回复/语音模式；TTS cancel 中止真正传给 provider 的信号；media.save 与发布前 revision fencing；用户要求语音时 hidden-draft（音频成功前不出现气泡、文字永不先显后消）。
- **P1-A**：spokenText/synthesisText 分离（transcript 存完整脚本、合成按 maxChars 裁剪）；Naturalness Guard 全项生效（不合格重写一次→规则降级）；Delivery Plan 真正消费（pace→speed、instructions 编译、用户保存的情绪映射优先）；7 个 VOICE_* flag 全部接入或删除。
- **P1-B**：睡眠 vitals（settle 按 life_state.kind 漂移，睡觉恢复 energy/偿还睡眠债）；conversation plan 可执行（activityId/freeformIntent/tags，无法解析保持 planned）；plan 生命周期闭环（life_state.meta 记录 planId，完成/跳过/outcome 落库）；thread 四个创建来源 + 活跃上限 3；时区统一 `localDateTimeToUtc/localDateOfIso`（不再 `startsWith(localDate)`）；continuity 真实因果上下文（买菜→做饭等）。
- **P1-C**：主动消息等待期间用户出现即取消（user_appeared）；主动语音改走 VoiceService 全链路（不再直接 `ttsProvider().synthesize`）。

### 门禁结果（分支 HEAD）
| 门禁 | 结果 |
|---|---|
| `npm ci` | ✅ |
| `npm run typecheck` | ✅ 0 error |
| `npm test -w @sooya/server` | ✅ 591/591 |
| `npm test -w @sooya/web` | ✅ 444/444 |
| `npm run build` | ✅ |
| Playwright E2E（desktop+mobile） | ✅ 84/84 |

### 已知限制（非阻断）
- 模型指令驱动的 replace（`[[voice-only]]`）仍走"文字已显示后替换"路径；用户指令驱动的 replace（用语音回我/只发语音）已实现 hidden-draft。模型侧很少直接输出该标记，前端也未提供该指令入口。
- 天气/地点/A-B/Shadow/管理面板 UI/语音偏好 UI 未实施（方案标注暂缓）。
- 失败卡片的「继续生成」（partial 续写）依赖 `POST /api/reply-batches/:id/retry`，前端按钮已就绪。
