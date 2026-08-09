# City Awareness and Responses Web Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 SOOYA 稳定感知当前城市，并在严格的意图门控下使用现有 DeepSeek Responses API 的原生 `web_search`，同时展示可点击来源且不污染长期记忆。

**Architecture:** `WebSearchPolicy` 先判断是否向模型开放搜索工具，`ContextBuilder` 从 `WorldContextService` 注入活动城市，`OpenAIResponsesProvider` 负责原生工具请求、最终回答和引用解析。联网回答采用完整响应缓冲，搜索使用状态与精简引用写入消息元数据，Memory/Summary 据此隔离外部事实，Web 端只增加消息气泡内的引用展示。

**Tech Stack:** TypeScript、Node.js、Fastify、Vitest、React 19、Responses API、SQLite message metadata

**Design spec:** `docs/superpowers/specs/2026-08-09-city-awareness-responses-web-search-design.md`

---

## File map

### New files

- `packages/server/src/core/web-search-policy.ts` — 纯函数搜索意图判定，不访问网络或数据库。
- `packages/server/test/web-search-policy.test.ts` — 搜索触发与反例测试。
- `packages/server/src/providers/chat/responses-payload.ts` — Responses 最终回答、搜索调用和引用的纯解析器。
- `packages/web/src/components/WebCitations.tsx` — 安全的行内引用与来源列表渲染。

### Modified files

- `packages/server/src/providers/types.ts` — 通用搜索请求和结果元数据契约。
- `packages/server/src/providers/chat/openai.ts` — Responses 请求体、联网缓冲与解析器接线。
- `packages/server/test/provider-responses.test.ts` — Responses 协议、DeepSeek 多 message 和引用测试。
- `packages/server/src/core/context.ts` — 注入活动城市并在 `BuiltContext` 返回规范化城市。
- `packages/server/src/app.ts` — 将 `WorldContextService` 传给 ContextBuilder；下游 job 传递搜索标记。
- `packages/server/test/location-city.test.ts` — 默认城市、切换城市、关闭功能的上下文测试。
- `packages/server/src/core/replier.ts` — 搜索策略、请求配置、结果元数据和消息持久化。
- `packages/server/test/helpers/harness.ts` — 支持伪造 Responses 请求与完整响应。
- `packages/server/test/chat.test.ts` — Replier 搜索/非搜索集成测试。
- `packages/server/src/core/jobs.ts` — 联网回答不参与 memory assistantText 抽取。
- `packages/server/src/core/summarizer.ts` — 联网回答在长期摘要中变成无事实占位符。
- `packages/server/test/memory-policy.test.ts` — Memory 隔离测试。
- `packages/server/test/memory.test.ts` — Summary 隔离测试。
- `packages/web/src/components/MessageItem.tsx` — 文本气泡接入引用组件。
- `packages/web/src/components/MessageItem.test.tsx` — 引用显示、协议过滤和文本安全测试。
- `packages/web/src/styles.css` — 引用链接和来源列表样式。
- `README.md` — 记录 Responses 原生搜索启用条件与边界。

---

### Task 1: Add the deterministic web-search policy

**Files:**
- Create: `packages/server/src/core/web-search-policy.ts`
- Create: `packages/server/test/web-search-policy.test.ts`

- [ ] **Step 1: Write the failing policy tests**

Create `packages/server/test/web-search-policy.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { decideWebSearch } from '../src/core/web-search-policy.js';

describe('decideWebSearch', () => {
  it.each([
    ['帮我联网查一下这条消息', 'explicit'],
    ['最近有什么重要新闻', 'fresh_external'],
    ['DeepSeek 最新版本是多少', 'fresh_external'],
    ['附近有什么好吃的', 'local'],
    ['宁波今天有什么活动', 'fresh_external'],
    ['今天适合出去玩吗', 'fresh_external'],
    ['现在人民币汇率是多少', 'fresh_external']
  ] as const)('offers search for %s', (text, reason) => {
    expect(decideWebSearch(text)).toEqual({ offer: true, reason });
  });

  it.each([
    '你好',
    '我今天很难过',
    '你现在在做什么',
    '你记得我不吃香菜吗',
    '我们之前聊过什么',
    '陪我说会儿话'
  ])('does not offer search for %s', (text) => {
    expect(decideWebSearch(text)).toEqual({ offer: false, reason: 'none' });
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npm run test -w @sooya/server -- test/web-search-policy.test.ts
```

Expected: FAIL because `../src/core/web-search-policy.js` does not exist.

- [ ] **Step 3: Implement the minimal policy**

Create `packages/server/src/core/web-search-policy.ts`:

```ts
export type WebSearchReason = 'none' | 'explicit' | 'local' | 'fresh_external';

export interface WebSearchDecision {
  offer: boolean;
  reason: WebSearchReason;
}

const EXPLICIT_SEARCH = /(?:联网|上网|搜(?:一下|索)?|查(?:一下|询)?|核实|求证)/iu;
const LOCAL_SCOPE = /(?:附近|周边|当地|本地|离我近|去哪(?:里)?|哪里有)/iu;
const LOCAL_TOPIC = /(?:吃|餐厅|饭店|咖啡|店|活动|展览|演出|景点|公园|商场|医院|药店|停车|充电|好玩|推荐)/iu;
const FRESHNESS = /(?:最新|最近|目前|当前|现在|实时|今天|今日|明天|本周|这个周末)/iu;
const EXTERNAL_TOPIC = /(?:新闻|热搜|天气|路况|交通|票价|价格|汇率|股价|比分|赛果|政策|法规|版本|发布|活动|展览|演出|营业时间|台风|航班|列车)/iu;
const OUTING_DECISION = /(?:适合.*(?:出去|出门|游玩)|要不要.*(?:出去|出门)|去哪(?:里)?玩)/iu;

export function decideWebSearch(text: string): WebSearchDecision {
  const normalized = text.trim();
  if (!normalized) return { offer: false, reason: 'none' };
  if (EXPLICIT_SEARCH.test(normalized)) return { offer: true, reason: 'explicit' };
  if (LOCAL_SCOPE.test(normalized) && LOCAL_TOPIC.test(normalized)) return { offer: true, reason: 'local' };
  if (FRESHNESS.test(normalized) && (EXTERNAL_TOPIC.test(normalized) || OUTING_DECISION.test(normalized))) {
    return { offer: true, reason: 'fresh_external' };
  }
  return { offer: false, reason: 'none' };
}
```

- [ ] **Step 4: Run the policy tests and verify GREEN**

Run:

```powershell
npm run test -w @sooya/server -- test/web-search-policy.test.ts
```

Expected: 13 tests pass, 0 fail.

- [ ] **Step 5: Commit the policy**

```powershell
git add packages/server/src/core/web-search-policy.ts packages/server/test/web-search-policy.test.ts
git commit -m "feat: classify web search intent"
```

---

### Task 2: Inject the active city into every chat context

**Files:**
- Modify: `packages/server/src/core/context.ts`
- Modify: `packages/server/src/app.ts`
- Modify: `packages/server/test/location-city.test.ts`

- [ ] **Step 1: Add failing city-context tests**

Append to `packages/server/test/location-city.test.ts` inside the existing describe block:

```ts
  async function buildCityContext(h: Harness): Promise<string> {
    const chat = h.app.config.chatModelFor('chat');
    const built = await h.app.services.context.build(h.app.config.getPersona(), '你在哪个城市', {
      recentMessages: 24,
      memoryLimit: 0,
      allowVision: false,
      stickerCatalogue: '',
      voiceMoods: '',
      capabilityNotes: [],
      contextWindow: chat.contextWindow,
      maxOutputTokens: chat.maxTokens
    });
    return built.system;
  }

  it('injects the active city and changes it immediately after a switch', async () => {
    harness = await enabledHarness();
    expect(await buildCityContext(harness)).toContain('中国浙江宁波');

    const hangzhou = harness.app.services.location.createCity({
      name: '杭州', region: '浙江', country: '中国', timeZone: 'Asia/Shanghai'
    });
    harness.app.services.location.setActiveCity(hangzhou.id);

    const system = await buildCityContext(harness);
    expect(system).toContain('中国浙江杭州');
    expect(system).not.toContain('中国浙江宁波');
  });

  it('does not invent a city when the location model is disabled', async () => {
    harness = await createHarness({ skipStickerImport: true, startWorkers: false });
    expect(await buildCityContext(harness)).not.toContain('当前所在城市');
  });
```

- [ ] **Step 2: Run the city tests and verify RED**

Run:

```powershell
npm run test -w @sooya/server -- test/location-city.test.ts
```

Expected: the two new assertions fail because ContextBuilder does not read WorldContextService.

- [ ] **Step 3: Add a normalized city contract to BuiltContext**

In `packages/server/src/core/context.ts`, import `WorldContextService` and add:

```ts
import type { WorldContextService } from './world-context.js';

export interface ContextCity {
  name: string;
  region?: string | null;
  country?: string | null;
}
```

Add `city?: ContextCity;` to `BuiltContext`, then add `world` before `timeZone` in the constructor:

```ts
    private readonly life?: LifeRuntime,
    private readonly world?: Pick<WorldContextService, 'snapshot'>,
    private readonly timeZone = 'Asia/Shanghai'
```

At the start of `build`, after `systemParts` is initialized, read the snapshot once and add the city line:

```ts
    const worldSnapshot = this.world?.snapshot();
    const city = worldSnapshot?.city
      ? {
          name: worldSnapshot.city.name,
          region: worldSnapshot.city.region ?? null,
          country: worldSnapshot.city.country ?? null
        }
      : undefined;
    if (city) {
      const label = [city.country, city.region, city.name].filter(Boolean).join('');
      systemParts.push(
        `你当前所在城市是${label}。涉及“附近”“当地”“今天去哪”等本地问题时，以该城市为范围；不要编造具体地址。`
      );
    }
```

Return `city` with the other `BuiltContext` fields.

- [ ] **Step 4: Wire WorldContextService into ContextBuilder**

In `packages/server/src/app.ts`, change the ContextBuilder construction to:

```ts
  const context = new ContextBuilder(
    repos.messages,
    repos.summaries,
    memory,
    repos.media,
    mediaStore,
    repos.mediaText,
    env.ENABLE_LIFE_ENGINE ? life : undefined,
    world,
    env.LIFE_TIME_ZONE
  );
```

- [ ] **Step 5: Run city tests and typecheck**

Run:

```powershell
npm run test -w @sooya/server -- test/location-city.test.ts test/world-context.test.ts
npm run typecheck -w @sooya/server
```

Expected: focused tests and server typecheck pass.

- [ ] **Step 6: Commit city context**

```powershell
git add packages/server/src/core/context.ts packages/server/src/app.ts packages/server/test/location-city.test.ts
git commit -m "feat: inject active city into chat context"
```

---

### Task 3: Extend the provider contract and build native web-search requests

**Files:**
- Modify: `packages/server/src/providers/types.ts`
- Modify: `packages/server/src/providers/chat/openai.ts`
- Modify: `packages/server/test/provider-responses.test.ts`

- [ ] **Step 1: Add failing request-body tests**

Add to the request-body describe block in `packages/server/test/provider-responses.test.ts`:

```ts
  it('adds native web_search with approximate city only when requested', async () => {
    const { p, sent } = provider(() => json({ output: [] }));
    await p.complete({
      ...TEXT_REQ,
      webSearch: {
        enabled: true,
        userLocation: { countryCode: 'CN', region: '浙江', city: '宁波' }
      }
    });

    expect(sent[0].body.tools).toEqual([{
      type: 'web_search',
      user_location: { type: 'approximate', country: 'CN', region: '浙江', city: '宁波' }
    }]);
    expect(sent[0].body.tool_choice).toBeUndefined();
  });

  it('does not expose tools for a normal request', async () => {
    const { p, sent } = provider(() => json({ output_text: '普通回答' }));
    await p.complete(TEXT_REQ);
    expect(sent[0].body.tools).toBeUndefined();
  });
```

- [ ] **Step 2: Run the provider tests and verify RED**

Run:

```powershell
npm run test -w @sooya/server -- test/provider-responses.test.ts
```

Expected: TypeScript/Vitest fails because `ChatRequest.webSearch` is not defined and the request has no `tools`.

- [ ] **Step 3: Add provider-neutral request/result types**

In `packages/server/src/providers/types.ts`, add before `ChatRequest`:

```ts
export interface WebSearchUserLocation {
  countryCode?: string;
  region?: string;
  city?: string;
}

export interface WebCitation {
  title: string;
  url: string;
  startIndex?: number;
  endIndex?: number;
}

export interface WebSearchResultMeta {
  used: boolean;
  callCount: number;
  citations: WebCitation[];
}
```

Add to `ChatRequest`:

```ts
  webSearch?: { enabled: true; userLocation?: WebSearchUserLocation };
```

Add to `ChatResult`:

```ts
  webSearch?: WebSearchResultMeta;
```

- [ ] **Step 4: Generate the Responses tool entry**

In `OpenAIResponsesProvider.body` in `packages/server/src/providers/chat/openai.ts`, add after `instructions`:

```ts
    if (req.webSearch?.enabled) {
      const location = req.webSearch.userLocation;
      const approximate = location
        ? Object.fromEntries(Object.entries({
            type: 'approximate',
            country: location.countryCode,
            region: location.region,
            city: location.city
          }).filter(([, value]) => Boolean(value)))
        : null;
      body.tools = [{
        type: 'web_search',
        ...(approximate && Object.keys(approximate).length > 1 ? { user_location: approximate } : {})
      }];
    }
```

Do not set `tool_choice: required`; the model must retain the option not to search.

- [ ] **Step 5: Run provider tests and typecheck**

```powershell
npm run test -w @sooya/server -- test/provider-responses.test.ts
npm run typecheck -w @sooya/server
```

Expected: request tests pass; all pre-existing Responses tests remain green.

- [ ] **Step 6: Commit the request contract**

```powershell
git add packages/server/src/providers/types.ts packages/server/src/providers/chat/openai.ts packages/server/test/provider-responses.test.ts
git commit -m "feat: add native web search request contract"
```

---

### Task 4: Parse only the final answer and collect citations safely

**Files:**
- Create: `packages/server/src/providers/chat/responses-payload.ts`
- Modify: `packages/server/src/providers/chat/openai.ts`
- Modify: `packages/server/test/provider-responses.test.ts`

- [ ] **Step 1: Add failing DeepSeek compatibility tests**

Add these cases to `packages/server/test/provider-responses.test.ts`:

```ts
  it('returns only the last completed assistant message after a search', async () => {
    const { p } = provider(() => json({
      status: 'completed',
      output: [
        { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'I need to search.' }] },
        { type: 'web_search_call', status: 'completed', action: { type: 'search', query: '宁波天气' } },
        { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '宁波今天有雨。' }] }
      ]
    }));
    expect((await p.complete({ ...TEXT_REQ, webSearch: { enabled: true } })).text).toBe('宁波今天有雨。');
  });

  it('collects structured citations and completed open-page URLs', async () => {
    const { p } = provider(() => json({
      status: 'completed',
      output: [
        { type: 'web_search_call', status: 'completed', action: { type: 'open_page', url: 'https://weather.example/ningbo' } },
        {
          type: 'message', role: 'assistant', status: 'completed',
          content: [{
            type: 'output_text', text: '今天有雨（天气站）。',
            annotations: [{
              type: 'url_citation', start_index: 5, end_index: 10,
              title: '天气站', url: 'https://weather.example/ningbo'
            }]
          }]
        }
      ]
    }));
    const result = await p.complete({ ...TEXT_REQ, webSearch: { enabled: true } });
    expect(result.webSearch).toEqual({
      used: true,
      callCount: 1,
      citations: [{ title: '天气站', url: 'https://weather.example/ningbo', startIndex: 5, endIndex: 10 }]
    });
  });

  it('falls back to legal URLs written in the final answer', async () => {
    const { p } = provider(() => json({
      status: 'completed',
      output: [
        { type: 'web_search_call', status: 'completed', action: { type: 'search' } },
        { type: 'message', role: 'assistant', status: 'completed', content: [{
          type: 'output_text', text: '来源：https://weather.example/ningbo'
        }] }
      ]
    }));
    const result = await p.complete({ ...TEXT_REQ, webSearch: { enabled: true } });
    expect(result.webSearch?.citations).toEqual([
      { title: 'weather.example', url: 'https://weather.example/ningbo' }
    ]);
  });

  it('buffers web search instead of streaming intermediate planning messages', async () => {
    const { p, sent } = provider(() => json({
      status: 'completed',
      output: [
        { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '中间规划' }] },
        { type: 'web_search_call', status: 'completed', action: { type: 'search' } },
        { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '最终答案' }] }
      ]
    }));
    const deltas: string[] = [];
    const result = await p.stream({ ...TEXT_REQ, webSearch: { enabled: true } }, (chunk) => deltas.push(chunk.delta));
    expect(sent[0].body.stream).toBe(false);
    expect(deltas).toEqual(['最终答案']);
    expect(result.text).toBe('最终答案');
  });
```

- [ ] **Step 2: Run the tests and verify RED**

```powershell
npm run test -w @sooya/server -- test/provider-responses.test.ts
```

Expected: the adapter concatenates intermediate messages, returns no search metadata, and sends `stream=true`.

- [ ] **Step 3: Implement the pure payload parser**

Create `packages/server/src/providers/chat/responses-payload.ts`:

```ts
import type { WebCitation, WebSearchResultMeta } from '../types.js';

export interface ResponsesContent {
  type?: string;
  text?: string;
  annotations?: Array<{
    type?: string;
    title?: string;
    url?: string;
    start_index?: number;
    end_index?: number;
  }>;
}

export interface ResponsesOutputItem {
  type?: string;
  role?: string;
  status?: string;
  content?: ResponsesContent[];
  action?: { type?: string; url?: string };
}

export interface ResponsesPayload {
  status?: string;
  output_text?: string | string[];
  output?: ResponsesOutputItem[];
  incomplete_details?: { reason?: string } | null;
}

function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function finalMessage(payload: ResponsesPayload): ResponsesOutputItem | undefined {
  return [...(payload.output ?? [])].reverse().find((item) =>
    item.type === 'message' && item.role === 'assistant' && item.status !== 'failed'
  );
}

function textOf(item: ResponsesOutputItem | undefined, payload: ResponsesPayload): string {
  const text = item?.content?.filter((part) => part.type === 'output_text' && typeof part.text === 'string')
    .map((part) => part.text ?? '').join('') ?? '';
  if (text) return text;
  if (typeof payload.output_text === 'string') return payload.output_text;
  return Array.isArray(payload.output_text) ? payload.output_text.join('') : '';
}

function citationsOf(item: ResponsesOutputItem | undefined, payload: ResponsesPayload): WebCitation[] {
  const collected: WebCitation[] = [];
  for (const part of item?.content ?? []) {
    for (const annotation of part.annotations ?? []) {
      if (annotation.type !== 'url_citation') continue;
      const url = safeHttpUrl(annotation.url);
      if (!url) continue;
      collected.push({
        title: annotation.title?.trim() || new URL(url).hostname,
        url,
        ...(Number.isInteger(annotation.start_index) ? { startIndex: annotation.start_index } : {}),
        ...(Number.isInteger(annotation.end_index) ? { endIndex: annotation.end_index } : {})
      });
    }
  }
  for (const output of payload.output ?? []) {
    if (output.type !== 'web_search_call' || output.status !== 'completed' || output.action?.type !== 'open_page') continue;
    const url = safeHttpUrl(output.action.url);
    if (url) collected.push({ title: new URL(url).hostname, url });
  }
  for (const match of textOf(item, payload).matchAll(/https?:\/\/[^\s<>"'）)\]}]+/giu)) {
    const url = safeHttpUrl(match[0]);
    if (url) collected.push({ title: new URL(url).hostname, url });
  }
  const seen = new Set<string>();
  return collected.filter((citation) => !seen.has(citation.url) && seen.add(citation.url)).slice(0, 5);
}

export function parseResponsesPayload(payload: ResponsesPayload): { text: string; webSearch: WebSearchResultMeta } {
  const message = finalMessage(payload);
  const calls = (payload.output ?? []).filter((item) => item.type === 'web_search_call');
  return {
    text: textOf(message, payload),
    webSearch: {
      used: calls.length > 0,
      callCount: calls.length,
      citations: citationsOf(message, payload)
    }
  };
}
```

- [ ] **Step 4: Use the parser and buffer searched responses**

In `packages/server/src/providers/chat/openai.ts`:

1. Import `parseResponsesPayload` and its `ResponsesPayload` type.
2. Delete the local `ResponsesPayload` and `extractResponsesText` definitions.
3. In `complete`, parse once and return metadata:

```ts
          const json = (await res.json()) as ResponsesPayload;
          const parsed = parseResponsesPayload(json);
          if (json.status === 'incomplete' && !parsed.text.trim()) {
            throw new ProviderRequestError(
              `responses request incomplete: ${json.incomplete_details?.reason ?? 'unknown'}`
            );
          }
          return { text: parsed.text, model: this.cfg.model, webSearch: parsed.webSearch };
```

4. At the start of `stream`, buffer only searched requests:

```ts
    if (req.webSearch?.enabled) {
      const result = await this.complete(req);
      if (result.text) onChunk({ delta: result.text });
      return result;
    }
```

5. In normal SSE `response.completed`, use `parseResponsesPayload(evt.response).text` for the existing no-delta fallback.

- [ ] **Step 5: Run provider tests and typecheck**

```powershell
npm run test -w @sooya/server -- test/provider-responses.test.ts
npm run typecheck -w @sooya/server
```

Expected: all Responses tests pass and no intermediate message is emitted.

- [ ] **Step 6: Commit the response parser**

```powershell
git add packages/server/src/providers/chat/responses-payload.ts packages/server/src/providers/chat/openai.ts packages/server/test/provider-responses.test.ts
git commit -m "fix: isolate final Responses answer and citations"
```

---

### Task 5: Wire search decisions through Replier and persist metadata

**Files:**
- Modify: `packages/server/src/core/replier.ts`
- Modify: `packages/server/test/helpers/harness.ts`
- Modify: `packages/server/test/chat.test.ts`

- [ ] **Step 1: Extend the fake harness for Responses**

In `packages/server/test/helpers/harness.ts`:

1. Add `chatProvider?: 'openai-chat' | 'openai-responses';` to `HarnessOptions`.
2. Change the fake chat URL branch to accept `/responses` as well as `/chat/completions`.
3. For non-streaming `/responses`, let `opts.chat.respond` return the complete payload; otherwise return:

```ts
return new Response(JSON.stringify({
  status: 'completed',
  output: [{
    type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: chunks.join(''), annotations: [] }]
  }]
}), { status: 200, headers: { 'content-type': 'application/json' } });
```

4. Set the fake chat config to:

```ts
provider: opts.chatProvider ?? 'openai-chat',
supportsTools: opts.chatProvider === 'openai-responses',
```

- [ ] **Step 2: Add failing Replier integration tests**

Append to `packages/server/test/chat.test.ts`:

```ts
  it('offers native search for a fresh local query and persists only final metadata', async () => {
    h = await createHarness({
      chatProvider: 'openai-responses',
      env: { WORLD_CONTEXT_ENABLED: 'true', LOCATION_MODEL_ENABLED: 'true' },
      chat: {
        respond: ({ body }) => {
          if (!(body as { tools?: unknown }).tools) return null;
          return new Response(JSON.stringify({
            status: 'completed',
            output: [
              { type: 'web_search_call', status: 'completed', action: { type: 'open_page', url: 'https://food.example/ningbo' } },
              { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '宁波附近可以试试这家店。' }] }
            ]
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
      }
    });

    const { body } = await sendText(h.app, '附近有什么好吃的');
    const reply = body.reply as ChatMessage;
    const request = h.state.chatCalls.at(-1)!.body as { tools?: unknown[] };
    expect(request.tools).toBeTruthy();
    expect(reply.meta?.webSearchUsed).toBe(true);
    expect(reply.meta?.webSearchCallCount).toBe(1);
    expect(reply.content.find((part) => part.type === 'text')?.meta?.webCitations).toEqual([
      { title: 'food.example', url: 'https://food.example/ningbo' }
    ]);
  });

  it('does not offer search for emotional chat even on a Responses model', async () => {
    h = await createHarness({ chatProvider: 'openai-responses' });
    await sendText(h.app, '我今天很难过');
    const request = h.state.chatCalls.at(-1)!.body as { tools?: unknown[] };
    expect(request.tools).toBeUndefined();
  });
```

Use the existing `sendText` import and `ChatMessage` type already present in `chat.test.ts`; do not create a second request helper.

- [ ] **Step 3: Run chat tests and verify RED**

```powershell
npm run test -w @sooya/server -- test/chat.test.ts
```

Expected: searched request has no tools and reply metadata is absent.

- [ ] **Step 4: Pass policy and city into the provider request**

In `packages/server/src/core/replier.ts`:

1. Import `decideWebSearch`, `ChatResult`, and `WebSearchResultMeta`.
2. After the existing `const capabilityNotes: string[] = [];`, move the existing `chatModel` declaration to that point and add:

```ts
      const webDecision = decideWebSearch(userText);
      const chatModel = this.deps.config.chatModelFor('chat');
      const webSearchAvailable = chatModel.provider === 'openai-responses' && chatModel.supportsTools;
      if (webDecision.offer) {
        capabilityNotes.push(webSearchAvailable
          ? '本轮可使用联网搜索核实实时外部信息；完成搜索后只输出最终回答并提供来源'
          : '联网搜索不可用，不能声称已经核实实时外部信息');
      }
```

Keep the existing `chatModel` declaration only once.

3. Before `streamTurns`, add:

```ts
      const countryCode = built.city?.country && /^(?:中国|China)$/iu.test(built.city.country) ? 'CN' : undefined;
      const webSearchRequest = webDecision.offer && provider.name === 'openai-responses' && chatModel.supportsTools
        ? {
            enabled: true as const,
            userLocation: {
              countryCode,
              region: built.city?.region ?? undefined,
              city: built.city?.name
            }
          }
        : undefined;
      let providerResult: ChatResult | null = null;
```

4. Make `streamTurns` capture and return the result:

```ts
      const streamTurns = async (turns: ChatTurn[]): Promise<void> => {
        providerResult = await provider.stream(
          {
            system: built.system,
            messages: turns,
            maxTokens: requestMaxTokens,
            temperature: undefined,
            signal,
            ...(webSearchRequest ? { webSearch: webSearchRequest } : {})
          },
          (chunk) => pushDelta(chunk.delta)
        );
      };
```

5. Add to `TextGenerationResult` and its return value:

```ts
  webSearch?: WebSearchResultMeta;
```

```ts
        webSearch: providerResult?.webSearch,
```

- [ ] **Step 5: Persist search and citation metadata**

In `publishGeneratedReply`, immediately before the final `stableBoundary` that marks `reply.content.done`, persist metadata after every text/voice path has produced its final shell:

```ts
    if (generated.webSearch?.used && shell) {
      const citations = generated.rawText.trim() === generated.text
        ? generated.webSearch.citations
        : generated.webSearch.citations.map(({ title, url }) => ({ title, url }));
      this.deps.messages.updateMeta(shell.id, {
        webSearchUsed: true,
        webSearchCallCount: generated.webSearch.callCount
      });
      if (textPartId && citations.length > 0) {
        const part = this.deps.messages.get(shell.id)?.content.find((candidate) => candidate.id === textPartId);
        this.deps.messages.updatePart(textPartId, {
          meta: { ...(part?.meta ?? {}), webCitations: citations }
        });
      }
    }
```

Dropping indexes after directive/speaker-prefix stripping prevents stale offsets from linking the wrong visible text; the same sources still appear in the fallback list.

Extend `ReplyOutcome` with `webSearchUsed?: boolean;` and return:

```ts
    return {
      messageId: shell.id,
      ok: true,
      parts: producedParts,
      degraded,
      webSearchUsed: generated.webSearch?.used === true
    };
```

- [ ] **Step 6: Run focused integration tests**

```powershell
npm run test -w @sooya/server -- test/chat.test.ts test/provider-responses.test.ts test/web-search-policy.test.ts test/location-city.test.ts
npm run typecheck -w @sooya/server
```

Expected: all focused tests and typecheck pass.

- [ ] **Step 7: Commit Replier integration**

```powershell
git add packages/server/src/core/replier.ts packages/server/test/helpers/harness.ts packages/server/test/chat.test.ts
git commit -m "feat: route eligible chat through native web search"
```

---

### Task 6: Enforce Memory and Summary isolation

**Files:**
- Modify: `packages/server/src/app.ts`
- Modify: `packages/server/src/core/jobs.ts`
- Modify: `packages/server/src/core/summarizer.ts`
- Modify: `packages/server/test/memory-policy.test.ts`
- Modify: `packages/server/test/memory.test.ts`

- [ ] **Step 1: Add a failing memory-job assertion**

In `packages/server/test/memory-policy.test.ts`, add a test that uses an injected memory extractor provider to record its transcript:

```ts
  it('does not pass a web-assisted answer into long-term memory extraction', async () => {
    const calls: Array<{ user: string; assistant: string }> = [];
    h = await createHarness({ startWorkers: false });
    vi.spyOn(h.app.services.memory, 'extractCandidates').mockImplementation(async (user, assistant) => {
      calls.push({ user, assistant });
      return [];
    });
    const user = h.app.repos.messages.create({ role: 'user', status: 'sent', parts: [{ type: 'text', text: '我不吃香菜，顺便查下今天油价' }] });
    const assistant = h.app.repos.messages.create({
      role: 'assistant', status: 'sent', parts: [{ type: 'text', text: '今天油价是外部实时数据' }],
      meta: { webSearchUsed: true }
    });
    h.app.repos.jobs.enqueue('memory.extract', {
      userMessageIds: [user.message.id],
      assistantMessageId: assistant.message.id,
      assistantWebSearchUsed: true
    });
    await h.app.services.worker.drain();
    expect(calls).toEqual([{ user: '我不吃香菜，顺便查下今天油价', assistant: '' }]);
  });
```

Also add `vi` to the existing Vitest import in this file:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
```

- [ ] **Step 2: Add a failing summary redaction test**

In `packages/server/test/memory.test.ts`, add this test inside `describe('context compression', ...)`:

```ts
  it('replaces web-assisted answers with a fact-free summary placeholder', async () => {
    h = await createHarness({
      env: { SUMMARY_TRIGGER_MESSAGES: '2', SUMMARY_CHUNK_MESSAGES: '2', CONTEXT_RECENT_MESSAGES: '0' },
      chat: { script: [['摘要完成']] }
    });
    h.app.repos.messages.create({
      role: 'user', status: 'sent', parts: [{ type: 'text', text: '查下今天油价' }]
    });
    h.app.repos.messages.create({
      role: 'assistant', status: 'sent',
      parts: [{ type: 'text', text: '今天油价是 8.21 元' }],
      meta: { webSearchUsed: true }
    });

    expect((await h.app.services.summarizer.runOnce()).created).toBe(true);
    const summaryPrompt = JSON.stringify(h.state.chatCalls.at(-1)!.body);
    expect(summaryPrompt).toContain('已通过联网回答，外部事实未保留');
    expect(summaryPrompt).not.toContain('今天油价是 8.21 元');
  });
```

- [ ] **Step 3: Run memory tests and verify RED**

```powershell
npm run test -w @sooya/server -- test/memory-policy.test.ts test/memory.test.ts
```

Expected: memory receives assistant text and summary transcript contains the live fact.

- [ ] **Step 4: Carry the search flag into the durable job**

In `packages/server/src/app.ts`, change the memory job payload in `onCompleted` to:

```ts
repos.jobs.enqueue('memory.extract', {
  batchId,
  revision,
  userMessageIds: userMessages.map((message) => message.id),
  assistantMessageId: outcome.messageId,
  assistantWebSearchUsed: outcome.webSearchUsed === true
});
```

In `packages/server/src/core/jobs.ts`, change assistant text selection to:

```ts
    const assistantWebSearchUsed = payload.assistantWebSearchUsed === true;
    const assistantText = assistantMessageId && !assistantWebSearchUsed
      ? textOf(deps.messages.get(assistantMessageId))
      : '';
```

- [ ] **Step 5: Redact searched assistant messages from summaries**

In `packages/server/src/core/summarizer.ts`, add at the start of `renderMessage`:

```ts
  if (msg.role === 'assistant' && msg.meta?.webSearchUsed === true) {
    return 'SOOYA: （已通过联网回答，外部事实未保留）';
  }
```

This preserves that the question was answered without retaining stale web facts.

- [ ] **Step 6: Run memory tests and typecheck**

```powershell
npm run test -w @sooya/server -- test/memory-policy.test.ts test/memory.test.ts test/chat.test.ts
npm run typecheck -w @sooya/server
```

Expected: all focused tests pass; ordinary non-search memory behavior remains unchanged.

- [ ] **Step 7: Commit the data boundary**

```powershell
git add packages/server/src/app.ts packages/server/src/core/jobs.ts packages/server/src/core/summarizer.ts packages/server/test/memory-policy.test.ts packages/server/test/memory.test.ts
git commit -m "feat: isolate web facts from long-term memory"
```

---

### Task 7: Render safe, clickable citations in message bubbles

**Files:**
- Create: `packages/web/src/components/WebCitations.tsx`
- Modify: `packages/web/src/components/MessageItem.tsx`
- Modify: `packages/web/src/components/MessageItem.test.tsx`
- Modify: `packages/web/src/styles.css`

- [ ] **Step 1: Add failing citation UI tests**

Append to `packages/web/src/components/MessageItem.test.tsx`:

```tsx
describe('MessageItem 联网来源', () => {
  it('renders structured citations as safe clickable links', async () => {
    await render(<MessageItem {...common} message={message({
      id: 'web-1',
      content: [{
        id: 'p-web', type: 'text', text: '宁波今天有雨（天气站）。', status: 'sent',
        meta: { webCitations: [{ title: '天气站', url: 'https://weather.example/ningbo', startIndex: 6, endIndex: 9 }] }
      }]
    } as never)} />);
    const link = container.querySelector<HTMLAnchorElement>('a.web-citation-inline');
    expect(link?.href).toBe('https://weather.example/ningbo');
    expect(link?.target).toBe('_blank');
    expect(link?.rel).toContain('noreferrer');
  });

  it('rejects non-http citation URLs and keeps their text inert', async () => {
    await render(<MessageItem {...common} message={message({
      id: 'web-2',
      content: [{
        id: 'p-web', type: 'text', text: '不要执行这个来源', status: 'sent',
        meta: { webCitations: [{ title: '坏链接', url: 'javascript:alert(1)' }] }
      }]
    } as never)} />);
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('不要执行这个来源');
  });

  it('shows fallback source links when citation indexes are unavailable', async () => {
    await render(<MessageItem {...common} message={message({
      id: 'web-3',
      content: [{
        id: 'p-web', type: 'text', text: '宁波今天有雨。', status: 'sent',
        meta: { webCitations: [{ title: 'weather.example', url: 'https://weather.example/ningbo' }] }
      }]
    } as never)} />);
    expect(container.querySelector('.web-citation-sources')?.textContent).toContain('weather.example');
  });
});
```

- [ ] **Step 2: Run the component test and verify RED**

```powershell
npm run test -w @sooya/web -- src/components/MessageItem.test.tsx
```

Expected: no citation anchors or source list are rendered.

- [ ] **Step 3: Implement the citation renderer**

Create `packages/web/src/components/WebCitations.tsx`:

```tsx
import type { ReactNode } from 'react';

interface Citation {
  title: string;
  url: string;
  startIndex?: number;
  endIndex?: number;
}

function safeCitation(value: unknown): Citation | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<Citation>;
  if (typeof raw.url !== 'string') return null;
  try {
    const url = new URL(raw.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return {
      title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : url.hostname,
      url: url.toString(),
      ...(Number.isInteger(raw.startIndex) ? { startIndex: raw.startIndex } : {}),
      ...(Number.isInteger(raw.endIndex) ? { endIndex: raw.endIndex } : {})
    };
  } catch {
    return null;
  }
}

export function WebCitedText({
  text,
  citations,
  renderPlain
}: {
  text: string;
  citations: unknown;
  renderPlain: (value: string, key: string) => ReactNode;
}) {
  const safe = Array.isArray(citations) ? citations.map(safeCitation).filter((item): item is Citation => Boolean(item)) : [];
  const indexed = safe
    .filter((item) => item.startIndex !== undefined && item.endIndex !== undefined && item.startIndex! >= 0 && item.endIndex! > item.startIndex! && item.endIndex! <= text.length)
    .sort((a, b) => a.startIndex! - b.startIndex!);
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const citation of indexed) {
    if (citation.startIndex! < cursor) continue;
    if (citation.startIndex! > cursor) nodes.push(renderPlain(text.slice(cursor, citation.startIndex), `plain-${cursor}`));
    nodes.push(
      <a className="web-citation-inline" href={citation.url} target="_blank" rel="noopener noreferrer" key={`citation-${citation.startIndex}-${citation.url}`}>
        {text.slice(citation.startIndex, citation.endIndex)}
      </a>
    );
    cursor = citation.endIndex!;
  }
  if (cursor < text.length) nodes.push(renderPlain(text.slice(cursor), `plain-${cursor}`));
  const fallback = safe.filter((item) => item.startIndex === undefined || item.endIndex === undefined);
  return <>
    {nodes.length > 0 ? nodes : renderPlain(text, 'plain-all')}
    {fallback.length > 0 && <span className="web-citation-sources" aria-label="联网来源">
      来源：{fallback.map((item, index) => <a href={item.url} target="_blank" rel="noopener noreferrer" key={item.url}>{index > 0 ? ' · ' : ''}{item.title}</a>)}
    </span>}
  </>;
}
```

- [ ] **Step 4: Integrate with MessageItem without breaking search highlighting**

Import `WebCitedText` in `MessageItem.tsx`. Replace the text bubble content with:

```tsx
<WebCitedText
  text={displayText}
  citations={part.meta?.webCitations}
  renderPlain={(value, key) => <span key={key}>{highlightedText(value, highlightQuery)}</span>}
/>
```

Keep the existing outer bubble, read-aloud button, directive stripping and media rendering unchanged.

- [ ] **Step 5: Add compact citation styles**

Append to `packages/web/src/styles.css`:

```css
.web-citation-inline {
  color: inherit;
  text-decoration: underline;
  text-decoration-color: color-mix(in srgb, currentColor 55%, transparent);
  text-underline-offset: 0.16em;
}

.web-citation-sources {
  display: block;
  margin-top: 0.55rem;
  padding-top: 0.45rem;
  border-top: 1px solid color-mix(in srgb, currentColor 16%, transparent);
  font-size: 0.78rem;
  opacity: 0.78;
}

.web-citation-sources a {
  color: inherit;
  text-decoration: underline;
  text-underline-offset: 0.14em;
}
```

- [ ] **Step 6: Run Web tests and typecheck**

```powershell
npm run test -w @sooya/web -- src/components/MessageItem.test.tsx
npm run typecheck -w @sooya/web
```

Expected: citation, unsafe URL, fallback source, existing quote/highlight tests all pass.

- [ ] **Step 7: Commit citation UI**

```powershell
git add packages/web/src/components/WebCitations.tsx packages/web/src/components/MessageItem.tsx packages/web/src/components/MessageItem.test.tsx packages/web/src/styles.css
git commit -m "feat: show clickable web citations"
```

---

### Task 8: Document, verify, deploy, and perform a live acceptance pass

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document the exact enablement contract**

Add under the model configuration section in `README.md`:

```markdown
### Responses 原生联网搜索

当聊天配置同时满足以下条件时，SOOYA 会对实时、外部或本地搜索意图开放 Responses 原生 `web_search`：

- `provider` 为 `openai-responses`
- `supportsTools` 为 `true`
- 当前模型端点实际支持 `/responses` 与 `web_search`

普通聊天不会附带搜索工具。联网工具结果只服务当前回答；来源会显示在消息气泡中，外部事实不会自动进入长期记忆或阶段摘要。城市来自 Life 的活动城市，城市功能关闭时不会猜测位置。
```

- [ ] **Step 2: Run every focused server suite**

```powershell
npm run test -w @sooya/server -- test/web-search-policy.test.ts test/provider-responses.test.ts test/location-city.test.ts test/world-context.test.ts test/chat.test.ts test/memory-policy.test.ts test/memory.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 3: Run every focused Web suite**

```powershell
npm run test -w @sooya/web -- src/components/MessageItem.test.tsx
```

Expected: all MessageItem tests pass.

- [ ] **Step 4: Run static verification and builds**

```powershell
npm run typecheck
npm run build
git diff --check
```

Expected: both typechecks and builds pass; `git diff --check` produces no output.

- [ ] **Step 5: Run the broad server suite and classify only known environment failures**

```powershell
npm test
```

Expected on Linux/CI: full pass. On the current Windows host, the known WSL interoperability failures may remain where `bash -n` receives a `C:\...` path; no new non-deploy test may fail.

- [ ] **Step 6: Commit documentation and verification state**

```powershell
git add README.md
git commit -m "docs: explain Responses web search rollout"
git status --short
```

Expected: the commit succeeds and the worktree is clean.

- [ ] **Step 7: Review the complete branch before production changes**

```powershell
git log --oneline --decorate main..HEAD
git diff --stat main...HEAD
git diff main...HEAD -- packages/server/src packages/server/test packages/web/src README.md
```

Verify all of the following from the diff:

- normal providers never receive `tools`;
- searched Responses requests never use `tool_choice: required`;
- searched replies publish only the final assistant message;
- citations are HTTP(S)-only and clickable;
- web facts are excluded from memory assistantText and summaries;
- no API key, token, password, raw search payload or full webpage body is persisted.

- [ ] **Step 8: Back up and switch only the chat provider after merge/deploy**

On the server, first create a recoverable backup of `/opt/sooya/shared/config/models.json`. Then use the existing admin model configuration to change only:

```json
{
  "chat": {
    "provider": "openai-responses",
    "baseUrl": "https://api.deepseek.com",
    "model": "deepseek-v4-flash",
    "supportsTools": true
  }
}
```

Keep the existing secret, timeout, context window, max tokens, temperature and retry values unchanged. Restart/reload through the existing deployment flow and verify `/health/live`, `/health/ready`, and the safe admin model view before sending chat traffic.

- [ ] **Step 9: Run live acceptance queries**

Send these queries through the real SOOYA chat UI in order:

1. `你现在在哪个城市？` — must answer 宁波 without search.
2. `附近有什么好吃的？` — must use web search and show at least one clickable source.
3. `我今天很难过。` — must not use web search and should respond without search latency.
4. Switch the active city to 杭州, then send `附近有什么活动？` — request must carry 杭州 and not 宁波.
5. Temporarily make web search unavailable in a controlled test — reply must state it cannot verify live information; ordinary follow-up chat must still work.

Inspect the saved assistant message after query 2: `meta.webSearchUsed=true`, citations are bounded, and no raw tool result is stored. Run the memory worker and summary path, then confirm the current weather/restaurant facts do not appear in long-term memories or the generated summary.

- [ ] **Step 10: Record production evidence and rollback point**

Record without secrets:

- deployed commit SHA;
- safe chat provider/model view;
- health results;
- one normal-chat latency observation;
- one searched-chat latency and source screenshot;
- city-switch proof;
- memory/summary isolation proof;
- backup path and the exact rollback action that restores `provider=openai-chat`.

If Responses search causes incomplete answers, exposed planning, missing final text, or repeated uncontrolled calls, restore the saved model configuration and restart SOOYA before investigating further.

---

## Plan self-review

- **Spec coverage:** Tasks 1–2 cover trigger policy and city awareness; Tasks 3–5 cover native Responses search and provider quirks; Task 6 covers Memory/Summary boundaries; Task 7 covers clickable citations; Task 8 covers documentation, regression verification, live evidence and rollback.
- **Scope:** No third-party search provider, crawler, search database, news sync or separate search page is introduced.
- **Type consistency:** `ChatRequest.webSearch`, `ChatResult.webSearch`, `TextGenerationResult.webSearch`, `ReplyOutcome.webSearchUsed`, message `meta.webSearchUsed`, and part `meta.webCitations` form one explicit chain from request to persistence and UI.
- **Baseline caveat:** The Windows worktree baseline has 8 unrelated WSL path failures in deployment-script syntax tests; all new focused suites must be green and CI/Linux is expected to validate those scripts normally.
