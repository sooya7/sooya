# City Awareness and Multi-provider Web Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 SOOYA 增加按意图触发、感知当前城市、支持豆包 Custom/Global、Tavily 与 Responses 原生回退的联网搜索，并显示安全引用且隔离长期记忆。

**Architecture:** 纯函数策略决定是否搜索；独立 `WebSearchService` 依次调用豆包和 Tavily 适配器并返回统一引用，搜索材料以有界不可信上下文送入现有 DeepSeek 聊天模型。外部提供商不可用时，只有支持工具的 Responses 聊天配置才能走原生搜索；最终消息保存精简元数据，前端只渲染安全 HTTP(S) 来源。

**Tech Stack:** TypeScript、Node.js Fetch、Zod、Fastify、Vitest、React 19、SQLite message metadata

**Design spec:** `docs/superpowers/specs/2026-08-09-city-awareness-responses-web-search-design.md`

---

## File map

### New files

- `packages/server/src/core/web-search/policy.ts` — 纯搜索意图分类。
- `packages/server/src/core/web-search/types.ts` — 搜索请求、结果、引用和提供商契约。
- `packages/server/src/core/web-search/doubao.ts` — 豆包 Custom/Global API Key 适配器。
- `packages/server/src/core/web-search/tavily.ts` — Tavily Search 适配器。
- `packages/server/src/core/web-search/service.ts` — 有序回退、超时、上下文格式化与脱敏错误。
- `packages/server/test/web-search-policy.test.ts` — 策略边界测试。
- `packages/server/test/web-search-providers.test.ts` — 两个提供商的请求/解析/错误测试。
- `packages/server/test/web-search-integration.test.ts` — Replier、城市、引用与降级集成测试。
- `packages/web/src/components/WebCitations.tsx` — 安全来源列表。

### Modified files

- `packages/server/src/config/env.ts`、`.env.example` — 搜索配置与密钥变量。
- `packages/server/src/core/context.ts`、`packages/server/src/app.ts` — 城市上下文和搜索服务接线。
- `packages/server/src/core/replier.ts` — 搜索调用、材料注入和元数据持久化。
- `packages/server/src/providers/types.ts`、`packages/server/src/providers/chat/openai.ts` — Responses 原生搜索请求/最终消息解析。
- `packages/server/test/provider-responses.test.ts`、`packages/server/test/helpers/harness.ts` — Responses 和外部搜索假端点。
- `packages/server/src/core/jobs.ts`、`packages/server/src/core/summarizer.ts`、相关测试 — 外部事实记忆隔离。
- `packages/web/src/components/MessageItem.tsx`、测试和 `styles.css` — 引用展示。
- `README.md` — 配置、密钥和上线说明。

---

### Task 1: 搜索配置、类型和触发策略

**Files:**
- Create: `packages/server/src/core/web-search/types.ts`
- Create: `packages/server/src/core/web-search/policy.ts`
- Create: `packages/server/test/web-search-policy.test.ts`
- Modify: `packages/server/src/config/env.ts`
- Modify: `.env.example`

- [ ] **Step 1: 写策略和环境配置失败测试**

测试实时事实、本地推荐触发；问候、情绪和内部状态不触发。测试 `loadEnv()` 默认提供商顺序为 `doubao,tavily,responses`，也允许选择任意单个或有序子集；最大结果为 5，默认豆包版本为 `custom`。

- [ ] **Step 2: 运行并确认 RED**

```powershell
npm run test -w @sooya/server -- test/web-search-policy.test.ts test/config-env.test.ts
```

预期：缺少 `decideWebSearch` 和搜索环境字段。

- [ ] **Step 3: 实现最小类型与策略**

核心契约：

```ts
export interface WebSearchRequest {
  query: string;
  maxResults: number;
  city?: string;
  region?: string;
  country?: string;
  freshness?: 'day' | 'week' | 'month' | 'year';
  signal?: AbortSignal;
}

export interface WebSearchCitation {
  title: string;
  url: string;
  snippet?: string;
  siteName?: string;
  publishedAt?: string;
}

export interface WebSearchProvider {
  readonly name: 'doubao' | 'tavily';
  readonly configured: boolean;
  search(request: WebSearchRequest): Promise<WebSearchResult>;
}
```

环境字段：`SOOYA_WEB_SEARCH_ENABLED`、`SOOYA_WEB_SEARCH_PROVIDERS`、`SOOYA_WEB_SEARCH_MAX_RESULTS`、`SOOYA_WEB_SEARCH_TIMEOUT_MS`、豆包 edition/base/key、Tavily base/key。

- [ ] **Step 4: 运行测试确认 GREEN**

```powershell
npm run test -w @sooya/server -- test/web-search-policy.test.ts test/config-env.test.ts
```

- [ ] **Step 5: 提交**

```powershell
git add packages/server/src/core/web-search packages/server/test/web-search-policy.test.ts packages/server/src/config/env.ts packages/server/test/config-env.test.ts .env.example
git commit -m "feat: define web search policy and configuration"
```

---

### Task 2: 豆包和 Tavily 适配器

**Files:**
- Create: `packages/server/src/core/web-search/doubao.ts`
- Create: `packages/server/src/core/web-search/tavily.ts`
- Create: `packages/server/test/web-search-providers.test.ts`

- [ ] **Step 1: 写提供商失败测试**

断言豆包使用 Bearer、`Query/SearchType/Count/NeedSummary/QueryControl`；Custom 才发送权威过滤；Global 限制 20 条。断言 Tavily 使用 Bearer、`basic`、不请求 answer/raw content、最多 5 条。两者都过滤非 HTTP(S) URL 并截断摘要。

- [ ] **Step 2: 运行并确认 RED**

```powershell
npm run test -w @sooya/server -- test/web-search-providers.test.ts
```

- [ ] **Step 3: 实现豆包适配器**

请求体：

```ts
const body = {
  Query: request.query,
  SearchType: 'web',
  Count: Math.min(request.maxResults, edition === 'global' ? 20 : 50),
  NeedSummary: true,
  QueryControl: { QueryRewrite: true },
  ...(edition === 'custom' ? { Filter: { AuthInfoLevel: 0 } } : {})
};
```

解析 `Result.WebResults`，错误仅带状态码和供应商名，不包含响应体、Key 或完整 query。

- [ ] **Step 4: 实现 Tavily 适配器**

请求体：

```ts
const body = {
  query: request.query,
  search_depth: 'basic',
  include_answer: false,
  include_raw_content: false,
  max_results: Math.min(request.maxResults, 5)
};
```

解析 `results[].title/url/content`。

- [ ] **Step 5: 运行测试确认 GREEN 并提交**

```powershell
npm run test -w @sooya/server -- test/web-search-providers.test.ts
git add packages/server/src/core/web-search packages/server/test/web-search-providers.test.ts
git commit -m "feat: add Doubao and Tavily search adapters"
```

---

### Task 3: 提供商回退与有界搜索上下文

**Files:**
- Create: `packages/server/src/core/web-search/service.ts`
- Modify: `packages/server/test/web-search-providers.test.ts`

- [ ] **Step 1: 写回退失败测试**

覆盖未配置跳过、豆包 401/429/5xx/超时/空结果后调用 Tavily、全部失败返回 unavailable、结果去重、最多 5 条和总上下文上限。

- [ ] **Step 2: 运行并确认 RED**

```powershell
npm run test -w @sooya/server -- test/web-search-providers.test.ts
```

- [ ] **Step 3: 实现 `WebSearchService`**

按环境顺序组装提供商，为每次调用创建不超过配置值的超时信号；格式化时将外部文本标记为不可信数据并编号 `[1]..[5]`。

- [ ] **Step 4: 运行测试确认 GREEN 并提交**

```powershell
npm run test -w @sooya/server -- test/web-search-providers.test.ts
git add packages/server/src/core/web-search/service.ts packages/server/test/web-search-providers.test.ts
git commit -m "feat: add bounded web search fallback service"
```

---

### Task 4: 城市与 Replier 接入

**Files:**
- Modify: `packages/server/src/core/context.ts`
- Modify: `packages/server/src/app.ts`
- Modify: `packages/server/src/core/replier.ts`
- Modify: `packages/server/test/helpers/harness.ts`
- Create: `packages/server/test/web-search-integration.test.ts`

- [ ] **Step 1: 写城市、注入和降级失败测试**

断言：附近问题把活动城市加入 query；普通聊天不发搜索请求；成功结果进入系统搜索材料；最终 text part 含 `webSearchUsed/provider/citations`；失败时模型收到“无法核实实时信息”而普通回答仍完成。

- [ ] **Step 2: 运行并确认 RED**

```powershell
npm run test -w @sooya/server -- test/web-search-integration.test.ts
```

- [ ] **Step 3: 接入应用依赖与城市上下文**

`buildApp()` 创建搜索服务并将 `world.snapshot` 与服务注入 ContextBuilder/Replier。ContextBuilder 在可用时加入当前城市说明，并返回规范化城市快照供 Replier 使用。

- [ ] **Step 4: 接入 Replier**

搜索发生在聊天调用前；材料加到本轮 system，聊天仍使用现有流式路径。`TextGenerationResult` 保存搜索元数据，文本 part 完成时合并 meta；失败只写脱敏错误并加入降级提示。

- [ ] **Step 5: 运行测试确认 GREEN 并提交**

```powershell
npm run test -w @sooya/server -- test/web-search-integration.test.ts test/location-city.test.ts test/chat.test.ts
git add packages/server/src packages/server/test
git commit -m "feat: ground chat replies with city-aware web search"
```

---

### Task 5: Responses 原生搜索回退

**Files:**
- Modify: `packages/server/src/providers/types.ts`
- Modify: `packages/server/src/providers/chat/openai.ts`
- Modify: `packages/server/test/provider-responses.test.ts`
- Modify: `packages/server/src/core/replier.ts`

- [ ] **Step 1: 写 Responses 失败测试**

覆盖 `tools:[{type:'web_search'}]`、近似城市、最后完成 message、`web_search_call` 计数、结构化/URL 回退引用、incomplete 和多 message 规划过滤。

- [ ] **Step 2: 运行并确认 RED**

```powershell
npm run test -w @sooya/server -- test/provider-responses.test.ts
```

- [ ] **Step 3: 实现通用请求/结果字段和 Responses 解析**

只有外部搜索全部失败且 provider 为 `openai-responses`、`supportsTools=true` 时发送原生搜索；联网请求使用完整响应缓冲，普通聊天仍流式。

- [ ] **Step 4: 运行测试确认 GREEN 并提交**

```powershell
npm run test -w @sooya/server -- test/provider-responses.test.ts test/web-search-integration.test.ts
git add packages/server/src/providers packages/server/src/core/replier.ts packages/server/test
git commit -m "feat: fall back to native Responses web search"
```

---

### Task 6: 引用 UI 与长期记忆隔离

**Files:**
- Create: `packages/web/src/components/WebCitations.tsx`
- Modify: `packages/web/src/components/MessageItem.tsx`
- Modify: `packages/web/src/components/MessageItem.test.tsx`
- Modify: `packages/web/src/styles.css`
- Modify: `packages/server/src/core/jobs.ts`
- Modify: `packages/server/src/core/summarizer.ts`
- Modify: `packages/server/test/memory-policy.test.ts`
- Modify: `packages/server/test/memory.test.ts`

- [ ] **Step 1: 写 UI 与记忆失败测试**

断言来源链接可见、HTTP(S) 可点击、危险协议被丢弃；联网 assistant 文本不进入 memory extract，摘要只保留占位说明。

- [ ] **Step 2: 运行并确认 RED**

```powershell
npm run test -w @sooya/web -- src/components/MessageItem.test.tsx
npm run test -w @sooya/server -- test/memory-policy.test.ts test/memory.test.ts
```

- [ ] **Step 3: 实现引用组件和记忆边界**

`WebCitations` 从 `part.meta.webCitations` 读取并验证 URL；Jobs/Summarizer 根据 `webSearchUsed` 隔离外部事实。

- [ ] **Step 4: 运行测试确认 GREEN 并提交**

```powershell
npm run test -w @sooya/web -- src/components/MessageItem.test.tsx
npm run test -w @sooya/server -- test/memory-policy.test.ts test/memory.test.ts
git add packages/web/src packages/server/src/core packages/server/test
git commit -m "feat: show web sources without persisting web facts"
```

---

### Task 7: 文档、全量验证、部署和配置导入

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 文档化环境变量、密钥安全和回退顺序**

说明豆包 Custom/Global、Tavily、Responses 回退、免费额度不是可用性保证，以及 Key 不进入仓库/备份证据。

- [ ] **Step 2: 本地验证**

```powershell
npm run test -w @sooya/server -- test/web-search-policy.test.ts test/web-search-providers.test.ts test/web-search-integration.test.ts test/provider-responses.test.ts test/location-city.test.ts test/memory-policy.test.ts test/memory.test.ts
npm run test -w @sooya/web -- src/components/MessageItem.test.tsx
npm run typecheck
npm run build
git diff --check
```

预期：所有聚焦测试、typecheck、build 和 diff check 通过；完整测试只允许记录已知 Windows/WSL 路径问题。

- [ ] **Step 3: 提交并审查分支**

```powershell
git add README.md
git commit -m "docs: explain multi-provider web search"
git status --short
git diff --stat main...HEAD
```

- [ ] **Step 4: 部署前备份**

备份生产环境文件、`models.json` 和当前部署提交/镜像标识；验证回滚命令，不回显密钥。

- [ ] **Step 5: 部署与配置导入**

部署已验证提交；从用户提供的本地文本文件按标签读取豆包与 Tavily Key，写入生产受限环境文件：

```env
SOOYA_WEB_SEARCH_ENABLED=true
SOOYA_WEB_SEARCH_PROVIDERS=doubao,tavily,responses
SOOYA_DOUBAO_SEARCH_EDITION=custom
SOOYA_DOUBAO_SEARCH_API_KEY=[REDACTED_SECRET]
SOOYA_TAVILY_API_KEY=[REDACTED_SECRET]
```

文件权限限制为服务账户可读，重启后仅检查配置状态布尔值和健康端点。

- [ ] **Step 6: 线上真实验收**

依次测试普通聊天、附近推荐、最新事实、城市切换、主动制造首选搜索失败后的 Tavily 回退；保存无密钥的请求结果、提供商名、引用可点击性、健康状态和回滚点。

- [ ] **Step 7: 失败时回滚**

若健康检查失败、普通聊天回归、出现无来源实时断言或规划泄漏，恢复备份环境/配置和旧部署版本并重启，确认旧功能恢复后再诊断。

---

## Plan self-review

- **Spec coverage:** 搜索策略、城市、两种外部提供商、Responses 回退、引用、记忆隔离、密钥安全、部署与回滚均有对应任务。
- **Type consistency:** `WebSearchRequest -> WebSearchResult -> TextGenerationResult.search -> part.meta.webCitations` 是唯一数据链。
- **Scope:** 不引入搜索数据库、爬虫、复杂管理页或原始网页持久化。
- **Secrets:** 所有示例只使用 `[REDACTED_SECRET]`；本地 Key 文件不进入 Git。
