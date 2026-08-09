# SOOYA 城市感知与 Responses 原生联网搜索设计

日期：2026-08-09  
状态：已确认，待实施

## 1. 目标

在不引入火山搜索、Tavily 等第二搜索供应商的前提下，让 SOOYA：

1. 稳定知道当前城市，城市切换后下一轮对话立即生效；
2. 对新闻、价格、版本、活动、附近地点等实时问题使用 Responses API 原生 `web_search`；
3. 普通聊天、情绪交流、个人记忆和 Life 状态问题不触发搜索；
4. 将当前城市用于本地搜索，但不编造详细地址；
5. 将来源清晰、可点击地展示给用户；
6. 不把搜索得到的外部事实自动写入长期记忆或长期摘要。

## 2. 已确认的现状与实测

- 服务端已经有 `OpenAIResponsesProvider`，支持 `/responses`、非流式响应和 SSE 文本增量；缺少的是原生搜索工具配置、搜索元数据解析与业务接线。
- 线上面板的实际聊天配置是 `openai-chat`、`https://api.deepseek.com`、`deepseek-v4-flash`，并且 `supportsTools=true`。
- 对同一 DeepSeek 通道的只读探测结果：
  - 普通 `/responses` 请求返回 HTTP 200、`status=completed`；
  - 加入 `tools: [{"type":"web_search"}]` 后返回 HTTP 200，并产生真实的 `web_search_call`；
  - 一次宁波实时天气探测完成了搜索和打开网页，约 23 秒后得到完整回答；
  - 当前 DeepSeek Responses 返回多个中间 `message`，且本次没有返回结构化 `url_citation`。若沿用现有“拼接全部 message 文本”的实现，会把英文搜索规划暴露给用户。
- OpenAI Responses 协议允许在 `tools` 中配置 `web_search`，模型可自行决定是否搜索；也支持通过 `user_location` 提供近似城市位置。官方协议要求联网来源在用户界面中清晰、可点击地显示。

因此，本项目不新增 `WebSearchProvider`。搜索是聊天模型的原生托管工具，但需要 SOOYA 在业务层控制何时开放，并兼容当前 DeepSeek Responses 的输出特点。

## 3. 总体数据流

```text
用户消息
  -> WebSearchPolicy 判断是否属于实时/外部/本地搜索意图
  -> ContextBuilder 注入当前城市与现有 Life/位置上下文
  -> 若命中且 chat=openai-responses 且 supportsTools=true
       -> Responses 请求附带 web_search + user_location
       -> 缓冲完整工具流程，只发布最终 assistant message
     否则
       -> 保持现有普通流式聊天
  -> 将搜索使用状态与来源写入 assistant message 元数据
  -> 前端显示可点击来源
  -> Memory/Summary 根据元数据隔离外部事实
```

## 4. 城市上下文

### 4.1 数据来源

城市只取 `WorldContextService.snapshot().city`。该快照来自 `LocationService.activeCity()` 的持久化状态，不从模型猜测，也不从天气文本反推。

### 4.2 注入位置

`ContextBuilder` 接收一个只读的 world snapshot 依赖，在构建系统提示时加入独立的“当前城市”段落，例如：

```text
你当前所在城市是中国浙江宁波。涉及“附近”“当地”“今天去哪”等本地问题时，以该城市为范围；不要编造具体地址。
```

现有 `LifeSimEngine -> LocationService.contextLines()` 仍负责“家、社区公园、行程中”等具体 Life 位置。城市与具体地点分层，避免重复或互相覆盖。

城市功能关闭或没有活动城市时不注入空值。切换城市后，每轮构建上下文都重新读取快照，因此无需重启或清缓存。

## 5. 搜索触发策略

新增纯函数 `WebSearchPolicy`，先做成本与延迟保护，再让模型决定是否真正调用工具。

### 5.1 开放搜索工具

- 用户明确说“查、搜、联网、核实、最新”；
- 新闻、当前价格、最新版本、实时交通、赛事结果、政策变化等时效问题；
- “附近、当地、本地”餐厅、活动、景点、商店等城市问题；
- “今天适合出去吗”这类同时包含当前时间与外部条件的决策问题。

### 5.2 不开放搜索工具

- 问候、闲聊、情绪交流；
- 用户自己的长期记忆、偏好或历史对话；
- SOOYA 当前 Life 状态、计划、位置等内部事实；
- 只出现“今天”但没有外部事实意图，例如“我今天很难过”。

策略命中只代表在 Responses 请求中提供工具，不使用 `tool_choice: required`。模型仍可根据问题决定不搜索，避免已实测的强制循环调用和 token 耗尽。

如果问题应搜索但当前聊天配置不是 `openai-responses`、未开启 `supportsTools` 或服务失败，则向模型加入“联网不可用，不能声称已核实实时信息”的能力提示，普通聊天仍可继续。

## 6. Responses 协议扩展

### 6.1 请求契约

扩展 `ChatRequest`，增加可选的搜索配置，而不是把 OpenAI 专有字段泄漏给 Replier：

```ts
webSearch?: {
  enabled: true;
  userLocation?: {
    countryCode?: string;
    region?: string;
    city?: string;
  };
}
```

只有 `OpenAIResponsesProvider` 消费该字段并生成：

```json
{
  "tools": [{
    "type": "web_search",
    "user_location": {
      "type": "approximate",
      "country": "CN",
      "region": "浙江",
      "city": "宁波"
    }
  }]
}
```

中国/China 映射为 `CN`；无法安全映射的国家代码不发送，但城市和地区仍可进入提示词。普通 Chat Completions 与 Anthropic 适配器忽略该可选能力，保持现状。

### 6.2 响应契约

扩展 `ChatResult`：

```ts
webSearch?: {
  used: boolean;
  callCount: number;
  citations: Array<{
    title: string;
    url: string;
    startIndex?: number;
    endIndex?: number;
  }>;
}
```

解析规则：

1. 统计 `web_search_call`，确认模型是否真实使用搜索；
2. 仅选择最后一个已完成的 assistant `message` 作为最终回答，不再拼接所有 message；
3. 优先读取最终 message 的 `url_citation`；
4. 对当前 DeepSeek 未返回 annotations 的情况，从已完成的 `open_page` 动作和最终文本中的合法 HTTP(S) URL 提取、去重并限制最多 5 个来源；
5. 忽略搜索过程中的中间规划文本；
6. `status=incomplete` 且没有可用最终回答时按提供商失败处理，不把半截推理显示给用户。

### 6.3 联网回答采用缓冲发布

当前 DeepSeek 会把搜索规划阶段也表示成 `message`。因此，联网请求走非流式 Responses，完成后一次性发布最终回答；普通 Responses 聊天继续使用现有 SSE 流式体验。

聊天页面已有等待/输入状态，v1 不新增复杂搜索进度页面。这样牺牲联网回答的逐字输出，换取不会泄漏内部规划、不会持久化半截搜索过程的确定性。

## 7. 来源展示

来源元数据写入最终文本 part 的 `meta.webCitations`，不把工具原始结果写入数据库。

前端文本气泡增加轻量引用渲染：

- 有合法 `startIndex/endIndex` 时，将对应引用文字渲染为可点击链接；
- 没有可用索引但有来源 URL 时，在回答下方显示“来源”链接列表；
- 仅允许 `http:` 和 `https:`，使用新窗口打开并设置安全的 `rel`；
- 没有结构化来源时不伪造引用。

这不是新页面，只是消息气泡的必要来源展示。

## 8. Memory / Summary 边界

搜索过程和网页内容只存在于 Responses 请求内部，不保存原始工具结果。

如果 `ChatResult.webSearch.used=true`：

1. assistant message 写入 `meta.webSearchUsed=true` 与精简来源列表；
2. `memory.extract` 仍处理用户文本，以免漏掉同轮用户偏好，但不给抽取器传入联网 assistant 文本；
3. `Summarizer` 将该 assistant 消息渲染为“已通过联网回答，外部事实未保留”的占位信息，避免把天气、价格、新闻等快照写进阶段摘要；
4. 最近消息窗口仍保留当前回答，支持紧接着的追问；离开最近窗口后只保留“已回答”这一事实。

## 9. 配置与上线

代码不自动改生产模型配置。上线时通过现有管理面板将 chat provider 从 `openai-chat` 改为 `openai-responses`，保留当前 DeepSeek base URL、model、key 与 `supportsTools=true`。

切换前后分别验证：

- 普通聊天仍能完成并保持原有语气；
- “你在哪个城市”回答宁波；
- “附近有什么好吃的”真实产生搜索调用并显示来源；
- “我今天很难过”不产生搜索调用；
- 城市切换后本地搜索使用新城市；
- 联网回答不生成外部事实记忆，不进入长期摘要；
- 搜索失败时给出诚实降级，不影响后续普通聊天。

## 10. 测试策略

测试遵循先失败、后实现：

- `provider-responses.test.ts`：请求体、最终 message 选择、搜索调用统计、引用解析、DeepSeek 多 message、incomplete、联网缓冲发布；
- 新增 `web-search-policy.test.ts`：正例、反例、城市本地意图与边界词；
- Context/Location 测试：默认宁波、切换城市、无城市不注入；
- Replier/Memory 测试：搜索元数据持久化、memory 不读取联网回答；
- Summarizer 测试：联网事实被占位符替代；
- Web 组件测试：结构化引用和回退来源链接可见、可点击且协议安全；
- 最后运行服务端聚焦测试、Web 聚焦测试、两端 typecheck、build，并在生产同配置上做真实 Responses 搜索冒烟测试。

当前 Windows 基线的完整服务端测试有 8 个既有失败，均为测试通过 WSL 执行 `bash -n C:\\...` 时路径被破坏；其余测试通过。本功能验证将单独报告这些环境失败，不把它们归因于本次改动。

## 11. 明确不做

- 不接入第二搜索供应商或第二套 API Key；
- 不实现爬虫、网页数据库、全网向量知识库或新闻同步；
- 不把网页正文、搜索查询过程或工具原始 payload 持久化；
- 不把搜索强制用于所有消息；
- 不新增复杂搜索管理页或搜索结果页。
