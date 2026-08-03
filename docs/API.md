# SOOYA API 文档

所有接口都在同一个进程上。基址默认 `http://127.0.0.1:8788`。

- [鉴权](#鉴权)
- [消息数据结构](#消息数据结构)
- [聊天 API](#聊天-api)
- [媒体 API](#媒体-api)
- [实时事件（SSE）](#实时事件sse)
- [健康检查](#健康检查)
- [管理 API](#管理-api)
- [错误约定](#错误约定)

---

## 鉴权

| 令牌 | 保护范围 | 未配置时 |
| --- | --- | --- |
| `WEB_CHAT_TOKEN` | 所有 `/api/*`（管理接口除外） | **开放**（单机/内网场景） |
| `ADMIN_API_TOKEN` | 所有 `/api/admin/*` | **全部返回 503**（fail-closed） |

`/health/*` **永远不需要令牌**，这样部署脚本和容器探针在本机探测时不会因为
`WEB_CHAT_TOKEN` 被误判为失败。健康响应不包含任何聊天内容或密钥。

令牌只通过请求 Header 传递（择一）：

```http
X-Sooya-Token: <WEB_CHAT_TOKEN>
Authorization: Bearer <WEB_CHAT_TOKEN>
```

管理接口用 `X-Admin-Token: <ADMIN_API_TOKEN>`。管理令牌同时也能通过聊天接口的鉴权，
这样运维工具只需要一个密钥。令牌比较使用常数时间算法。

长期令牌不能放入 URL query 或 fragment；`?token=` 与 `?admin_token=` 不属于受支持的
鉴权方式。媒体和 SSE 客户端同样必须使用 Header 鉴权：媒体由前端鉴权请求后转为
临时 Blob URL，SSE 使用带 `Authorization` Header 的 fetch 流。这样可避免令牌进入
浏览器历史、Referer、缓存键以及服务器、代理或监控的 URL 日志。

> **API Key 永不返回前端。** `GET /api/admin/models` 会把每个 `apiKey` 替换成
> `apiKeyConfigured: true|false`。日志与 `error_log` 表在写入前做密钥脱敏。

---

## 消息数据结构

消息不是一段字符串，而是有序的 `content` 片段数组。

```jsonc
{
  "id": "msg_ms49sr4jf8bgyzkauq",
  "conversationId": "main",            // 永远是 "main"
  "role": "assistant",                 // user | assistant | system
  "createdAt": "2026-07-28T06:38:04.090Z",
  "updatedAt": "2026-07-28T06:38:07.412Z",
  "seq": 42,                           // 单调递增，分页和补偿都用它
  "status": "sent",                    // pending | sending | sent | failed
  "clientMsgId": "c_ms49_ab12cd",      // 幂等键（用户消息）
  "replyTo": "msg_...",                // 助手消息回复的那条用户消息
  "error": null,
  "content": [
    { "id": "part_...", "type": "text", "text": "我在呢。", "status": "sent" },
    {
      "id": "part_...", "type": "sticker", "mediaId": "media_...", "status": "sent",
      "meta": { "stickerId": "sticker_...", "stickerName": "happy", "reason": "exact-hint" },
      "media": { "id": "media_...", "kind": "sticker", "mime": "image/png", "bytes": 1808,
                 "width": 128, "height": 128, "url": "/api/media/media_..." }
    },
    {
      "id": "part_...", "type": "image", "mediaId": "media_...", "status": "sent",
      "media": { "kind": "image", "mime": "image/png", "width": 320, "height": 200,
                 "url": "/api/media/media_..." }
    },
    {
      "id": "part_...", "type": "audio", "mediaId": "media_...", "status": "sent",
      "duration": 3.13, "transcript": "我在呢。",
      "media": { "kind": "audio", "mime": "audio/mpeg", "duration": 3.13, "url": "/api/media/media_..." }
    }
  ],
  "meta": {}
}
```

### `content[].type`

| 类型 | 说明 | 关键字段 |
| --- | --- | --- |
| `text` | 文本 | `text` |
| `sticker` | 表情包 | `mediaId`, `meta.stickerName` |
| `image` | 图片（上传或生成） | `mediaId`, `media.width/height` |
| `audio` | SOOYA 生成的语音（历史消息兼容） | `mediaId`, `duration`, `transcript` |
| `file` | 任意文件 | `mediaId`, `media.name`, `media.bytes` |
| `system` | 系统提示 | `text` |

### `content[].status`

- `pending` — 已占位，媒体还在生成
- `sent` — **只有内容真的生成/落盘成功后才会写成 sent**
- `failed` — 该片段失败，`error` 说明原因

单个媒体片段失败**不会**导致整条文字回复丢失：文字片段仍然是 `sent`，
整条消息的 `status` 仍然是 `sent`，失败信息记录在对应片段上。

---

## 聊天 API

### `GET /api/conversation`

返回唯一会话的元信息。

```jsonc
{
  "conversationId": "main",
  "persona": { "name": "SOOYA", "avatar": "/avatars/sooya.svg",
               "userAvatar": "/avatars/user.svg", "tagline": "在线" },
  "messageCount": 128,
  "lastSeq": 128,
  "lastEventSeq": 517          // 用它初始化 SSE 的 Last-Event-ID
}
```

### `GET /api/messages`

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `limit` | 1–100 | 30 | 每页条数 |
| `before` | int | – | 取 `seq < before` 的更早消息（向上翻页） |
| `since` | int | – | 取 `seq > since` 的更新消息（断线对账） |

```jsonc
// GET /api/messages?limit=30
{ "messages": [ /* 按 seq 升序 */ ], "hasMore": true, "oldestSeq": 99, "lastEventSeq": 517 }
```

向上翻页：用当前最旧一条的 `seq` 作为下一次的 `before`，直到 `hasMore` 为 `false`。

### `POST /api/messages`

发送消息，**立即返回**，回复通过 SSE 推送。

```jsonc
// 请求
{
  "clientMsgId": "c_ms49_ab12cd",     // 必填，幂等键
  "content": [
    { "type": "text", "text": "看这张图" },
    { "type": "image", "mediaId": "media_..." }
  ],
  "directives": { "wantVoice": true }  // 可选，显式覆盖文本推断出的意图
}
```

```jsonc
// 响应 200
{ "message": { /* 已入库的用户消息 */ }, "duplicate": false, "replyPending": true }
```

**幂等**：同一个 `clientMsgId` 重复提交返回 `duplicate: true` 和原消息，
不会重复入库，也不会触发第二次回复。

`directives` 可选字段：`wantSticker` `wantImage` `wantVoice` `voiceOnly`
`noSticker` `anotherSticker`。不传时服务端会从文本里解析（「发个表情」「用语音说」
「不要发表情」等）。

### `POST /api/messages/sync`

同上，但**等回复生成完毕**再返回。适合脚本、测试和不使用 SSE 的客户端。

```jsonc
{
  "message": { /* 用户消息 */ },
  "duplicate": false,
  "reply":   { /* 完整的助手消息 */ },
  "outcome": { "messageId": "msg_...", "ok": true,
               "parts": ["text", "sticker", "audio"],
               "degraded": ["image:ProviderNotConfiguredError"] }
}
```

`degraded` 如实列出降级项，空数组表示全部按计划完成。

### `GET /api/messages/:id`

单条消息。

### `GET /api/stickers`

前端表情面板用的可用表情列表。**文件不存在的表情不会出现在这里。**

```jsonc
{ "stickers": [ { "id": "sticker_...", "name": "happy", "emotion": "开心",
                  "tags": ["开心","高兴","笑"], "url": "/api/media/media_...",
                  "mediaId": "media_..." } ] }
```

---

## 媒体 API

### `POST /api/media`

`multipart/form-data`。**字段名决定媒体类型**，因此一次请求可以混合上传。

| 字段名 | 类型 | 限制 |
| --- | --- | --- |
| `image` / `images` | 图片 | PNG, JPEG, GIF, WebP, BMP, AVIF |
| `file` / `files` | 文件 | pdf, txt, md, csv, json, zip, tar, gz, docx, xlsx, pptx |

用户语音输入与转写已移除；音频字段会返回 `415 UNSUPPORTED_FIELD`。音频文件如需保存，
请使用 `file` 字段，服务端按普通文件处理，不会把它作为用户语音输入。

限制：单文件 `MAX_UPLOAD_BYTES`（默认 25 MB），单请求 `MAX_UPLOAD_FILES`（默认 9）。

**类型以文件内容为准**，不信任客户端声明的 `Content-Type`。把 ELF 改名成 `.png`
并声明 `image/png` 会被拒绝。SVG 不在图片白名单内（脚本注入风险）。

```jsonc
// 200
{ "media": [ { "id": "media_...", "kind": "image", "mime": "image/png",
               "bytes": 1808, "width": 128, "height": 128,
               "url": "/api/media/media_...", "name": "photo.png" } ],
  "failed": [] }

// 415 —— 全部失败
{ "media": [], "failed": [ { "filename": "evil.png", "error": "image type not allowed: application/x-elf",
                             "code": "TYPE_NOT_ALLOWED" } ] }
```

`code`：`EMPTY` `TOO_LARGE` `UNKNOWN_TYPE` `TYPE_NOT_ALLOWED` `TOO_MANY_FILES` `SAVE_FAILED`。

### `GET /api/media/:id`

返回文件本身。支持 `Range`（语音拖动进度依赖它），带
`Cache-Control: private, max-age=604800, immutable` 和 `X-Content-Type-Options: nosniff`。
`kind=file` 时附 `Content-Disposition: attachment`。

可选 `?w=<像素宽度>` 返回缩略图：宽度向上取到档位 `240 / 480 / 960`，响应是
`image/webp`，ETag 形如 `"<id>-w<档位>-<字节数>"`，变体落盘复用。不支持分段续传
（变体只有几十 KB，不返回 `Accept-Ranges`）。以下情况静默回退原图，不报错：
`w` 不是 1–99999 的整数、超过最大档位、原图本来就不比档位宽、不是可缩放的图片
（GIF 可能是动图、BMP 无解码器）、或解码失败。前端气泡和头像默认按显示宽度乘设备
像素比（封顶 2 倍）请求缩略图，点开大图时再取原图。

路径穿越受多层防护：id 必须匹配 `^[A-Za-z0-9_-]{1,64}$`，磁盘路径经过 `safeJoin`
（处理 `..`、URL 编码、绝对路径、符号链接逃逸）。即使数据库里被塞入
`rel_path = "../../etc/passwd"` 也无法读到媒体根目录之外的文件。

### `GET /api/media/:id/meta`

```jsonc
{ "media": { /* MediaRef */ }, "exists": true }
```

### `POST /api/media/:id/transcribe`

已移除。该路径返回 `404`；系统不再提供用户音频转写。

---

## 实时事件（SSE）

### `GET /api/stream`

`text/event-stream`。断线重连时带上 `Last-Event-ID` 请求头（或 `?lastEventId=`），
服务端会**补发所有遗漏事件**。

连接建立后首先收到一条 `stream.ready`：

```jsonc
{
  "lastEventSeq": 517,      // 服务端当前的事件高水位
  "oldestEventSeq": 100,    // 还能补发的最早事件
  "replayed": 12,           // 本次补发了多少条
  "gapPossible": false,     // true = 有事件已被清理，补不全
  "lastMessageSeq": 128
}
```

**`gapPossible: true` 时客户端必须改用 `GET /api/messages?since=<本地最大 seq>` 对账。**
这条规则加上「事件先落库再推送」，共同保证了不会出现「回复已写入数据库但页面永远看不到、
必须刷新才出现」的情况。

#### 事件类型

| 事件 | 何时触发 | 主要字段 |
| --- | --- | --- |
| `message.received` | 用户消息已入库 | `message` |
| `reply.thinking` | 开始生成回复 | `messageId`, `replyTo` |
| `reply.text.delta` | 文字流式增量 | `messageId`, `delta`, `text` |
| `reply.text.done` | 文字生成完毕 | `messageId`, `text` |
| `reply.sticker.selecting` | 正在挑表情 | `messageId`, `hint` |
| `reply.image.generating` | 正在生成图片 | `messageId`, `prompt` |
| `reply.audio.generating` | 正在生成语音 | `messageId`, `chars` |
| `reply.content.done` | 全部内容生成完毕 | `messageId`, `parts[]` |
| `reply.media.saved` | 单个媒体保存完毕/失败 | `partId`, `kind`, `mediaId`, `failed`, `reason` |
| `reply.completed` | 回复发送完成 | `message`（完整消息）, `degraded[]` |
| `reply.failed` | 回复失败 | `messageId`, `error`, `message` |
| `memory.updated` | 长期记忆有变化 | `stored`, `merged`, `cleared` |
| `system.notice` | 系统通知（清空、恢复备份等） | `notice` |

每条事件都带 `id:`（等于 `seq`），客户端据此推进 `Last-Event-ID`。
连接空闲时每 15 秒发一个 `: ping` 注释保活。

### `GET /api/events?since=<seq>&limit=200`

轮询兜底，返回同样的事件。适用于 SSE 被中间层阻断的环境。

---

## 健康检查

| 端点 | 用途 | 状态码 |
| --- | --- | --- |
| `GET /health/live` | 进程是否存活（容器 liveness） | 恒 200 |
| `GET /health/ready` | 是否可以服务流量（readiness） | 200 / 503 |
| `GET /health/deep` | 含数据库 `integrity_check` 与能力概览 | 200 / 503 |
| `GET /api/capabilities` | 各能力的详细配置状态 | 200 |

```jsonc
// GET /health/ready
{ "status": "ready", "version": "1.0.0", "dbRecovered": false, "dbRecoveredFrom": null,
  "checks": { "database": { "ok": true },
              "mediaDir": { "ok": true, "detail": "/app/data/media" },
              "stickers": { "ok": true, "detail": "11 available" },
              "jobs":     { "ok": true, "detail": "0 pending" } } }
```

```jsonc
// GET /api/capabilities —— 未配置的能力如实上报，不会假装可用
{ "capabilities": {
    "chat":      { "configured": true,  "ok": true,  "provider": "openai-chat", "model": "gpt-4o-mini" },
    "vision":    { "configured": true,  "ok": true },
    "summary":   { "configured": true,  "ok": true },
    "embedding": { "configured": false, "ok": false, "detail": "not configured" },
    "image":     { "configured": false, "ok": false, "detail": "not configured" },
    "tts":       { "configured": false, "ok": false, "detail": "not configured" } },
  "stickers": { "available": 11, "total": 11 },
  "memory":   { "total": 12, "withEmbedding": 0, "coverage": 0, "byKind": { "profile": 3 } },
  "agent":    { "active": false, "tools": 0 } }
```

> `configured` 表示「配置齐全」，`ok` 表示「配置齐全且端点地址通过 SSRF 校验」。
> 两者都**不代表**已经成功调用过第三方 API——真正的可用性只能在部署后用真实密钥验证。

---

## 管理 API

v1 提供管理面板网页（`/admin/features` 进入功能管理，`/admin` 面板用于人格/模型/能力配置），并预留后端接口。全部需要 `X-Admin-Token`；`ADMIN_API_TOKEN` 未配置时所有管理接口返回 503。

### 人格

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/admin/persona` | 读取完整人格 |
| `PUT` | `/api/admin/persona` | 局部更新（原子写入 `config/persona.json`） |

### 模型与能力

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/admin/models` | 模型配置（**apiKey 已脱敏**） |
| `PUT` | `/api/admin/models` | 深度合并更新并热重建能力 |
| `GET` | `/api/admin/capabilities` | 能力状态 + 当前 embedding 维度 |
| `PUT` | `/api/admin/tts` | 便捷接口：`{ model, policy }` |
| `PUT` | `/api/admin/image` | 便捷接口：`{ model, policy }` |

### 表情包

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/admin/stickers` | 全部表情（含 `available` 磁盘状态） |
| `POST` | `/api/admin/stickers` | 上传（multipart，可带 `name` `emotion` `tags`） |
| `PATCH` | `/api/admin/stickers/:id` | 改标签 / 情绪 / 启用状态 / 名称 |
| `DELETE` | `/api/admin/stickers/:id` | 删除表情及其媒体文件 |

### 记忆

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/admin/memories` | 列表 + 统计（`?limit&offset&kind`） |
| `DELETE` | `/api/admin/memories/:id` | 删除单条 |
| `POST` | `/api/admin/memories/clear` | **彻底清空** |

清空会同时删除：记忆、来源关联、FTS 索引（rebuild）、阶段摘要、相关后台任务。
清空后的内容不会再进入模型上下文。

### 媒体 / 聊天

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/admin/media` | 媒体列表（`?limit&offset&kind`） |
| `DELETE` | `/api/admin/media/:id` | 删除媒体记录与文件 |
| `POST` | `/api/admin/chat/clear` | 清空聊天（消息、片段、摘要、事件） |

### 系统与日志

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/admin/system` | 版本、运行时长、内存、存储占用、数据库统计、SSE 订阅数、Agent 预留状态 |
| `GET` | `/api/admin/errors` | 最近错误（已脱敏，最多 500 条） |
| `DELETE` | `/api/admin/errors` | 清空错误日志 |
| `GET` | `/api/admin/jobs` | 后台任务队列 |

### 备份

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/admin/backups` | 备份列表 |
| `POST` | `/api/admin/backups` | 立即备份（SQLite 在线备份 API + 校验） |
| `POST` | `/api/admin/backups/:name/verify` | 校验和 + `integrity_check` |
| `POST` | `/api/admin/backups/:name/restore` | 恢复（先关连接再替换文件，原库留存为 `.pre-restore-*`） |
| `DELETE` | `/api/admin/backups/:name` | 删除备份 |

---

## 错误约定

```jsonc
{ "error": "unauthorized", "message": "valid WEB_CHAT_TOKEN required" }
```

| 状态码 | `error` | 含义 |
| --- | --- | --- |
| 400 | `bad_request` | 参数校验失败，附 `issues`（Zod） |
| 400 | `unknown_media` | 引用了不存在的 `mediaId` |
| 401 | `unauthorized` | 令牌缺失或错误 |
| 404 | `not_found` | 资源不存在 |
| 413 | `file_too_large` | 超过上传或请求体上限 |
| 415 | – | 上传文件类型不被允许 |
| 416 | – | Range 请求越界 |
| 500 | `backup_failed` | 备份失败 |
| 503 | `admin_disabled` | 未配置 `ADMIN_API_TOKEN` |

