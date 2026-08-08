# INTEGRATION-NOTES — Agent D：Visible Thoughts + Decision Trace

Worktree: `.worktrees/sooya-thoughts`（branch `agent/visible-thoughts`）
契约依据：`docs/NEXT-PHASE-CONTRACTS.md` §1.6 / §2 / §3 / §4 / §5
安全边界：**这不是暴露真实隐藏推理**。只生成"可公开、安全、简短的思考摘要"；ThoughtSafetyFilter 命中 → drop thought，绝不阻塞正常回复。

## SUMMARY

实现可见思考层（Visible Inner Thought + Admin Decision Trace）：

1. **数据模型 + repo**：`VisibleThought`（§1.6 全字段）+ `DecisionTrace`。`db/repos/thought.repo.ts`：`create/get/getUserThought/getByMessage/getByBatchRevision/listAdmin/completeThought/failThought/cancelThought/cancelOpenThoughts/saveTrace/getTrace/recentTraces`。`completeThought` 的 `generating → completed` 原子转换就是 thought 的 publish barrier（等价于 reply 的 `visible_at`）。
2. **ThoughtPresenter**（`core/thoughts/presenter.ts`）：`prepare({ batchId, revision, messageId, userMessage, finalReply, safeLifeContext, safeWorldContext, replyIntent, voiceMode, decisionMetadata, signal })`。inner_monologue 用固定指令 + 白名单输入调 `chatProvider().complete()`（1~3 句自然中文，≤60 字，strip 引号/指令标记）；decision_summary 由白名单输入程序化拼装（不调模型）。失败/超时/safety 命中 → thought `failed`，绝不影响回复。
3. **ThoughtSafetyFilter**（`core/thoughts/safety.ts`）：内置拦截 API key（sk-…/Bearer/长 base64/hex）、system prompt 片段（"你是X"、系统提示词…）、内部路径（/home/、C:\、sooya.db、migrations…）、provider 配置（baseUrl、models.json…）、工具参数（response_format、max_tokens、input_images…）、隐藏安全规则（绝不能、guardrail…）、raw memory 工件（importance:/confidence:/memory_sources…）；另支持 `refs` 注入真实 secret / 禁用词 / persona 名。命中 → drop + `errorLog.add('thoughts.safety', ...)`。
4. **Revision fencing + AbortSignal + publish barrier**：thought 状态转换全部走 DB fence；用户新消息（`onMessageAccepted` action ≠ 'appended'、`retryBatch`、`stop`）→ `cancelOpenThoughts()` + abort 在飞模型调用；stale thought 绝不显示。
5. **ReplyCoordinator 集成**（已实现，flag OFF / 未接线时零行为变化，`test/reply-coordinator.test.ts` 10/10 通过）：
   - 插入点 A：`startGeneration` 中 `publishGeneratedReply` 返回后、`if (!outcome.ok)` 早退块之后 → `notifyThoughtsReplyCompleted(...)`（fire-and-forget，不 await）。
   - 插入点 B：`onMessageAccepted` 中 `cancelProactive()` 之后 → `if (action !== 'appended') notifyThoughtsUserActivity()`。
   - 插入点 C：`retryBatch` 首行、`stop()` 置位后 → `notifyThoughtsUserActivity()`。
   - 插入点 D：`runLegacyGeneration`（非可打断路径）`complete` 成功后同样 `notifyThoughtsReplyCompleted(...)`（finalReply 从消息回读）。
   - 新增可选项 `thoughts?: ThoughtsBridge`（`core/thoughts/bridge.ts`：`beginForReply` / `onUserActivity`）；未提供时行为与基线完全一致。
6. **Decision Trace**：回复发布后同步写 `DecisionTrace`（replyIntent 启发式分类 / lifeContext 安全摘要 / weather / memoryRecallCount（ContextBuilder.memoryRecallTrace().stats.recalled）/ voiceMode（voice_generations.latestForMessage）/ semanticGuard（由 degraded + voiceFallbackReason + voice row 推导）/ experimentVariant（可空 seam，Agent C 落地后接线）/ proactive=null）。admin-only。
7. **Routes**（`routes/thoughts.ts`）：`GET /api/thoughts/:messageId`（user token 保护；仅 completed + visibility=user 的 inner_monologue）、`GET /api/admin/decision-trace?batchId=&revision=`、`GET /api/admin/decision-trace/recent`（admin token 保护，fail-closed）。service 未接线时返回 404 / 空列表。
8. **SSE/事件**：`StreamEventType` 新增 `'thought.updated'`（core/types.ts，非 §5 独占文件）。payload：`{ thought: { id, messageId, batchId, revision, kind, visibility, status, text } }`（text 仅 completed 时携带）。

## FILES_CHANGED

新增：
- `packages/server/src/core/thoughts/types.ts`（§1.6 冻结类型）
- `packages/server/src/core/thoughts/flags.ts`（`ThoughtsFlags` + `readThoughtsFlags`，全部默认 OFF）
- `packages/server/src/core/thoughts/safety.ts`（`ThoughtSafetyFilter`）
- `packages/server/src/core/thoughts/presenter.ts`（`ThoughtPresenter` + `cleanMonologue`）
- `packages/server/src/core/thoughts/trace.ts`（`DecisionTraceService` + `classifyReplyIntent` + `semanticGuardFrom`）
- `packages/server/src/core/thoughts/bridge.ts`（`ThoughtsBridge`）
- `packages/server/src/core/thoughts/service.ts`（`ThoughtsService`：bridge 实现 + 路由读面）
- `packages/server/src/db/repos/thought.repo.ts`（`ThoughtRepo`）
- `packages/server/src/routes/thoughts.ts`（`registerThoughtRoutes`）
- `packages/server/test/thoughts.test.ts`（8 用例）
- `packages/server/test/thoughts-safety.test.ts`（19 用例）
- `packages/server/test/decision-trace.test.ts`（6 用例）

修改：
- `packages/server/src/core/reply-coordinator.ts`（仅可选项 + 4 个最小插入点 + 2 个私有 helper + 1 个模块级 helper）
- `packages/server/src/core/types.ts`（StreamEventType 增加 `'thought.updated'`）
- `packages/server/src/db/migrations.ts`（**临时** version 904 `tmp_visible_thoughts`，最终 DDL 见 MIGRATION_NEEDS，由 Integration 统一重写为 v24）

未触碰：`app.ts`、`config/env.ts`、`AppShell.tsx`、`.env.example`、`docs/*`、voice/life2/location/weather/metrics/shadow/experiments 模块。

## TESTS

命令（packages/server 下）：
`npx vitest run test/thoughts.test.ts test/thoughts-safety.test.ts test/decision-trace.test.ts test/reply-coordinator.test.ts`

结果：**44/44 PASS**（`npm run typecheck` 0 error）

| 文件 | 用例数 | 覆盖 |
| --- | --- | --- |
| thoughts.test.ts | 8 | 普通回复 → user-visible thought + decision_summary；GET /api/thoughts/:messageId 200/404；用户中途发新消息 → 旧 thought cancelled（不挂新回复、不显示）；已发布 thought 在新消息后保持；thought 模型失败 → 回复正常 + thought failed；thought 泄露 secret → 被 filter 丢弃 + 安全事件；全部 flag OFF → 零行、零模型调用；仅 trace ON → 有 trace 无模型调用 |
| thoughts-safety.test.ts | 19 | 拦截真实 sk- key / apiKey 赋值 / Bearer / 长 base64 / 长 hex / persona 提示词片段（你是X）/ system prompt 提及 / 绝对路径 / provider 配置 / 工具参数 / 隐藏规则 / raw memory / refs-secret / refs-forbiddenTerm；放行正常中文；cleanMonologue 裁剪 |
| decision-trace.test.ts | 6 | 回复完成后写 trace（replyIntent=emotional_support、lifeContext 安全摘要、memoryRecallCount）；admin API 200/401；参数校验 400/404；recent 最新优先；user API 绝不返回 trace 字段；trace flag OFF → 无记录 |
| reply-coordinator.test.ts | 10（回归） | 集成后零行为变化 |

测试基建说明：harness 的 `chat.respond` 钩子**不会被 await**（必须同步返回）；"慢 thought"通过延迟响应 body 流实现；thought 请求通过 messages 里 system-role turn 的内容（含"可见想法"标记）识别——provider 把 system 放进 messages，不在顶层 `system` 字段。

## PUBLIC_API

```http
GET /api/thoughts/:messageId
  # requireChatToken（WEB_CHAT_TOKEN 未设置时开放）
  # 仅当消息存在且 thought 为 completed + inner_monologue + visibility=user
  # 200 { thought: VisibleThought } | 404 { error: 'not_found' }

GET /api/admin/decision-trace?batchId=<id>&revision=<n>
  # requireAdminToken（fail-closed）
  # 400（缺参/非法）| 200 { trace: DecisionTrace } | 404

GET /api/admin/decision-trace/recent?limit=<1..200>
  # requireAdminToken；200 { traces: DecisionTrace[] }（created_at DESC）
```

事件：`thought.updated`（payload 见 SUMMARY 第 8 条）。

## MIGRATION_NEEDS

Integration 统一编号 **v24**（当前 worktree 内临时版本 904 可整体替换）：

```sql
-- v24 visible_thoughts
CREATE TABLE visible_thoughts (
  id         TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  batch_id   TEXT NOT NULL,
  revision   INTEGER NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('inner_monologue','decision_summary')),
  text       TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL CHECK (visibility IN ('user','admin')),
  status     TEXT NOT NULL CHECK (status IN ('generating','completed','cancelled','failed')),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_thoughts_message ON visible_thoughts(message_id);
CREATE INDEX idx_thoughts_batch_rev ON visible_thoughts(batch_id, revision);
CREATE INDEX idx_thoughts_visibility ON visible_thoughts(visibility);
CREATE INDEX idx_thoughts_created ON visible_thoughts(created_at);

CREATE TABLE decision_traces (
  batch_id     TEXT NOT NULL,
  revision     INTEGER NOT NULL,
  payload_json TEXT NOT NULL,   -- DecisionTrace 除 batchId/revision/createdAt 外的字段
  created_at   TEXT NOT NULL,
  PRIMARY KEY (batch_id, revision)
);
CREATE INDEX idx_decision_traces_created ON decision_traces(created_at DESC);
```

## ENV_NEEDS

`config/env.ts` 增加（boolish 同现有风格，默认全 OFF）：

```ts
VISIBLE_THOUGHTS_ENABLED: boolish(false),        // 总开关：thought + trace 整层
VISIBLE_INNER_MONOLOGUE_ENABLED: boolish(false), // 单独门控 inner monologue 模型调用
ADMIN_DECISION_TRACE_ENABLED: boolish(false),    // 单独门控 decision trace 写入
VISIBLE_THOUGHTS_TIMEOUT_MS: intish(8000)        // 单次 thought 模型调用预算（可选）
```

`.env.example` 同四行注释为"默认关闭的可见思考层"。

## INTEGRATION_STEPS

1. **构造（app.ts，Integration 所有）**：
   ```ts
   import { ThoughtRepo } from './db/repos/thought.repo.js';
   import { ThoughtSafetyFilter } from './core/thoughts/safety.js';
   import { ThoughtPresenter } from './core/thoughts/presenter.js';
   import { DecisionTraceService } from './core/thoughts/trace.js';
   import { ThoughtsService } from './core/thoughts/service.js';
   import { readThoughtsFlags } from './core/thoughts/flags.js';
   import { registerThoughtRoutes } from './routes/thoughts.js';

   const thoughtRepo = new ThoughtRepo(dbHandle);
   const thoughtFlags = readThoughtsFlags(process.env); // 或从 env.ts 解析后的值构造
   const traces = new DecisionTraceService({
     repo: thoughtRepo,
     world: () => world.snapshot(),
     life: () => { const s = life.snapshot(); return { activity: s.activity, mood: s.mood }; },
     context: () => context,
     voice: (id) => repos.voice.latestForMessage(id),
     experiments: experiments, // Agent C 落地后；结构: { canonicalVariantForSubsystem(s: string): string | null }
   });
   const thoughts = new ThoughtsService({
     flags: thoughtFlags,
     repo: thoughtRepo,
     presenter: new ThoughtPresenter({
       repo: thoughtRepo,
       chat: () => capabilities.chatProvider(),
       safety: new ThoughtSafetyFilter(),
       bus,
       errorLog: repos.errors,
       safetyRefs: { personaName: config.getPersona().name }, // 可再加真实 key/禁用词
       timeoutMs: thoughtFlags.thoughtTimeoutMs,
     }),
     traces,
     messages: repos.messages,
     errorLog: repos.errors,
   });
   ```
2. **接线 coordinator**：`new ReplyCoordinator({ ..., thoughts })`（关键插入点已在 `reply-coordinator.ts` 内实现，见 SUMMARY 第 5 条；接线前后 coordinator 语义不变）。
3. **暴露给路由**：`app.services.thoughts = thoughts`（`SooyaApp['services']` 类型加 `thoughts: ThoughtsService` 或仅 `ThoughtsApi` 结构；路由通过 `(app.services as ...).thoughts` 读取，缺失时 404/空列表）。
4. **注册路由**：在 `buildApp` 的路由注册区（`registerVoiceRoutes` 附近）加一行 `registerThoughtRoutes(app);`。
5. **SSE/前端消费建议（Agent E 协作）**：
   - 订阅 `thought.updated`；按 `thought.messageId` 关联到助理消息气泡。
   - `status='generating'` → 可显示"正在想…"占位；`'completed'` → 显示 text（kind=inner_monologue 才渲染给用户；decision_summary 仅 admin 面板）；`'cancelled'`/`'failed'` → 收起占位。
   - 迟到客户端回退：`GET /api/thoughts/:messageId`。
   - admin 面板：`/api/admin/decision-trace?batchId=&revision=` + `/recent`。
6. **测试用临时 migration 904 由 v24 替换**（MIGRATION_NEEDS）。

## KNOWN_RISKS

1. **`semanticGuard` 是持久化工件推导**（degraded 标记 / text part meta `voiceFallbackReason` / voice row 存在性），不是对模型行为的直接观测；语义上"pass/reject/fallback"是近似。字段仅供 admin 诊断。
2. **`replyIntent` 是确定性启发式**（关键词正则），可能误分类；文档已注明，非模型判断。
3. **partial reply**（publish 后 provider 死亡，`reply.publishing.partial` 路径）：不会生成 thought/trace（`notifyThoughtsReplyCompleted` 只在 `outcome.ok` 且正常 complete 前触发）。
4. **proactive 回复**（`enqueueProactive` 任务路径）不经过 `startGeneration`，本轮无 thought/trace；如需覆盖，后续在 proactive task.run 成功后补一个 `thoughts.beginForReply` 调用（同一 bridge）。
5. **memoryRecallCount 取 ContextBuilder 最后一次 build 的 trace**；单用户串行下即本批次的值；若未来并行 generation，需改为按 batch 传递。
6. **thought 模型调用没有独立重试**（有意为之：宁可 drop 也不阻塞/重复）；`VISIBLE_THOUGHTS_TIMEOUT_MS` 超时 → thought `failed`。
7. **cancelOpenThoughts 是全会话级**（单用户应用）；若未来多会话需按 conversation/batch 维度收窄。
8. **route 注册发生在 buildApp 内**（Fastify v5 在 listen 前可注册，测试已验证 inject 路径可用）；不要在 listen 之后动态注册。
9. **`stream.ts` / 前端 SSE 事件类型**若在 web 侧有独立类型副本（如 `StreamEventType` 镜像），Agent E 需同步加 `thought.updated`。
10. 未跑全量测试套件（按任务约束）；建议 Integration 在 v24 落库后跑 `test/migration-upgrade.test.ts` 验证 23→24 升级路径（本 migration 为纯 CREATE TABLE，无数据迁移，风险低）。
