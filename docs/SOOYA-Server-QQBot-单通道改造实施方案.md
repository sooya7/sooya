# SOOYA Server 官方 QQ Bot 单通道改造实施方案

> 基线仓库：`/opt/sooya/src`  
> 目标：以 **QQ 官方 Bot 作为唯一聊天通道**，SOOYA Server 作为唯一业务主脑，Web 仅保留 Admin 管理能力。  
> 原则：**不重写 SOOYA 核心，只替换聊天入口、出口与主动消息投递链路。**

---

## 0. 实施目标

最终架构：

```text
QQ 官方 Bot
    │
    │ inbound event
    ▼
SOOYA Server
├── QQ Adapter
├── MessageIngressService
├── ReplyCoordinator
├── Replier
├── Director
├── Life / Life2
├── Proactive
├── Ombre Memory
├── Image / Vision
├── TTS / Voice
├── Sticker
├── Weather / Location / World
├── Web Search / Tools / MCP
├── Jobs / Scheduler
└── Admin API
    │
    ├── qq.deliver
    ▼
QQ 官方 Bot

Web Admin
    │
    └── 仅调用 Admin API，不再承担聊天功能
```

---

# 1. 当前基线

## 1.1 唯一开发基线

使用：

```text
/opt/sooya/src
```

这是 Git 源仓库。

当前已确认关键后端代码与 `/opt/sooya/current` 发布快照一致。

不要以：

```text
/opt/sooya-portal
```

作为 SOOYA 主脑改造基线。

`sooya-portal` 保持独立，不参与本次 QQ Bot 主链路改造。

---

# 2. 保留能力

以下 Server 能力原则上全部保留：

- `ReplyCoordinator`
- `Replier`
- `Director`
- `MediaDirector`
- Chat Provider
- Vision
- Image
- TTS / Voice
- Summary
- Embedding
- Rerank
- Web Search
- Tool Runtime
- MCP
- Life V1
- Life V2
- Location
- Weather
- World Presence
- Ombre Memory
- Jobs / Worker
- Sticker
- Thoughts
- Metrics
- Storage
- Backup
- Admin API
- 消息数据库
- 媒体数据库
- 日志 / error_log

本次不重新实现这些能力。

---

# 3. 移除 / 下线能力

最终下线：

- Web 普通聊天页
- PWA 聊天
- 浏览器 Push
- Web Push Subscription
- Service Worker
- PWA manifest
- NapCat
- OneBot
- 旧 `qq-bridge`
- 个人 QQ 登录链路
- SSE → bridge → OneBot 发送链路
- IPA / PWA 作为消息通道的职责

IPA 数据迁移相关功能不要第一阶段直接删除。

先完成 QQ Bot 上线并稳定运行，再做最终清理。

---

# 4. P0：抽离 MessageIngressService

## 4.1 目标

当前 `/api/messages` 内包含：

```text
输入校验
→ 保存 user message
→ clientMsgId 去重
→ 生成 message.received
→ 创建 / 合并 reply batch
→ ReplyCoordinator
```

这些逻辑不能继续绑定在 Web Route 中。

新增：

```text
packages/server/src/core/message-ingress.ts
```

建议接口：

```ts
export interface MessageIngressInput {
  clientMessageId: string;
  source: 'qq';
  conversationId: string;
  senderId: string;
  replyTo?: string | null;
  content: MessageContentPart[];
  metadata?: Record<string, unknown>;
}

export interface MessageIngressResult {
  messageId: string;
  duplicate: boolean;
  batchId?: string;
  replyPending: boolean;
}

export class MessageIngressService {
  async accept(input: MessageIngressInput): Promise<MessageIngressResult>;
}
```

## 4.2 从 `routes/chat.ts` 抽离

迁移以下职责：

- `SendMessageSchema` 后的业务流程
- `storedInputParts`
- directives 解析
- `messages.createInTransaction`
- sticker meaning job
- `message.received`
- `replyBatches.appendOrCreateMessage`
- `replyCoordinator.onMessageAccepted`

Route 层只负责协议转换和 HTTP 返回。

## 4.3 验收

原有 `/api/messages` 测试必须继续通过。

新增 `message-ingress.test.ts` 覆盖：

- 正常消息
- 重复 clientMessageId
- replyTo
- 多段 content
- 图片输入
- 同时到达两条消息
- reply batch 合并
- DB transaction 回滚

---

# 5. P1：QQ 官方 Bot Adapter

新增目录：

```text
packages/server/src/channels/qq/
├── client.ts
├── config.ts
├── inbound.ts
├── outbound.ts
├── verify.ts
├── media.ts
├── mapping.ts
├── types.ts
└── errors.ts
```

新增路由：

```text
packages/server/src/routes/qq.ts
```

---

## 5.1 `config.ts`

统一读取 QQ 配置。

建议环境变量：

```text
QQ_BOT_ENABLED
QQ_APP_ID
QQ_APP_SECRET
QQ_CALLBACK_SECRET
QQ_ENV
QQ_ALLOWED_USERS
QQ_PROACTIVE_ENABLED
```

注意：

- Secret 不进 Git
- Secret 不进数据库导出
- Secret 不打印日志
- Admin API 只能显示“已配置 / 未配置”
- 日志只能输出 App ID 的安全摘要，不输出 Secret

实际字段名应在开发时根据当时腾讯官方 QQ Bot 文档确认。

---

## 5.2 `verify.ts`

负责 QQ Event 来源校验：

- 签名验证
- 时间戳窗口
- replay protection
- challenge / verification event
- 非法请求直接拒绝
- 错误写入安全日志

---

## 5.3 `inbound.ts`

将 QQ 原始 Event 转换成 SOOYA 标准输入。

支持顺序：

### 第一阶段
- C2C / 私聊文字
- reply / quote

### 第二阶段
- 图片
- 文件
- 语音
- 表情 / 富媒体

内部输出统一为：

```ts
MessageIngressInput
```

QQ 原始 Event 不允许直接进入 Replier。

---

# 6. QQ Event 幂等

QQ Event 必须具有独立幂等层。

新增表：

```sql
channel_event
```

建议字段：

```text
id
channel
event_id
event_type
conversation_key
received_at
processed_at
status
error_code
```

唯一约束：

```text
(channel, event_id)
```

处理流程：

```text
收到 QQ Event
→ 校验签名
→ 尝试写 channel_event
→ 已存在：直接 ACK
→ 新事件：转换
→ MessageIngressService
→ 标记 processed
```

避免：

- QQ 重推导致重复回复
- Server 重启后重复处理
- Webhook timeout 后平台重试导致重复模型调用

---

# 7. 会话映射

新增表：

```sql
channel_identity
```

建议字段：

```text
id
channel
external_user_id
external_conversation_id
scene
sooya_conversation_id
enabled
created_at
updated_at
last_seen_at
```

当前只有 QQ，也建议保留该表。

目的不是做多通道框架，而是稳定解决：

```text
QQ 用户 / 群
→ SOOYA 内部会话
```

如果当前 SOOYA 只允许一个用户：

- 首次授权用户绑定为 owner
- 其他用户拒绝或忽略
- Admin 可查看绑定关系
- 不允许通过普通 QQ 消息修改 owner

---

# 8. P2：QQ Outbound / `qq.deliver`

## 8.1 不允许 ReplyCoordinator 直接调用 QQ API

错误方式：

```text
ReplyCoordinator
→ HTTP QQ API
```

正确方式：

```text
ReplyCoordinator
→ 保存 assistant message
→ enqueue qq.deliver
→ Worker
→ QQ API
```

---

## 8.2 修改 `app.ts`

当前 Reply 完成后：

```text
memory commit
push.reply
summary
life.conversation
```

修改为：

```text
memory commit
qq.deliver
summary
life.conversation
```

移除：

```text
push.reply
```

---

## 8.3 新增 Job

在 `core/jobs.ts` 增加：

```text
qq.deliver
```

payload：

```ts
{
  messageId: string;
  conversationId: string;
}
```

Job 内：

1. 读取 assistant message
2. 查 QQ conversation mapping
3. 检查 delivery 是否已完成
4. 转换内容
5. 上传媒体
6. 调 QQ 发送 API
7. 保存 remote message id
8. 标记 sent
9. 失败则按错误类型重试

---

# 9. Durable Outbox

新增表：

```sql
channel_delivery
```

建议字段：

```text
id
channel
message_id
external_conversation_id
status
attempts
next_retry_at
remote_message_id
last_error_code
last_error_summary
created_at
updated_at
delivered_at
```

唯一约束建议：

```text
(channel, message_id, external_conversation_id)
```

状态：

```text
pending
sending
retry
sent
failed
```

---

## 9.1 重试原则

建议：

```text
第 1 次：立即
第 2 次：5 秒
第 3 次：30 秒
第 4 次：2 分钟
第 5 次：10 分钟
```

具体可接入现有 jobs retry/backoff。

以下错误可重试：

- 网络超时
- 5xx
- 临时限流
- token 临时失效并成功刷新后

以下错误不无限重试：

- 用户无权限
- conversation 不存在
- 参数非法
- 媒体格式永久不支持

---

## 9.2 发送幂等

必须保证：

```text
SOOYA message_id
```

只对应一次成功 QQ 投递。

Worker 重启、Job 重试、Server 重启，都不能重复发送。

---

# 10. P3：QQ Client

`client.ts` 只负责官方 QQ API。

职责：

- token 获取 / 刷新
- 统一 HTTP client
- request timeout
- rate-limit 识别
- error normalize
- send text
- send rich message
- media upload
- message reply
- API metrics

禁止把：

- SOOYA DB
- Life
- Memory
- ReplyCoordinator

塞进 QQ Client。

QQ Client 必须保持“纯协议客户端”。

---

# 11. P4：媒体投递

## 11.1 图片

流程：

```text
Replier / MediaDirector
→ MediaStore
→ assistant message image part
→ qq.deliver
→ QQ media upload
→ QQ send
```

不要重新生成图片。

使用 SOOYA 已保存的媒体。

---

## 11.2 语音

流程：

```text
TTS
→ MediaStore
→ audio part
→ QQ media adapter
→ QQ
```

需要根据 QQ 官方当前支持格式转换。

必要时新增：

```text
packages/server/src/channels/qq/media.ts
```

做：

- MIME 判断
- 音频格式转换
- 大小限制
- 上传
- media id 缓存

---

## 11.3 Sticker

SOOYA Sticker Picker 保留。

投递策略：

1. QQ 支持原媒体：直接发送
2. 不支持：转图片 / GIF
3. 转换失败：降级为文本回复，不让整条回复失败

---

# 12. P5：Life 主动消息改造

这是本项目最重要的体验改造之一。

当前 `ProactiveComposer` 主要写入 Moments。

目标：

```text
Life Candidate
→ ProactiveComposer
→ 生成主动内容
→ 创建 assistant message
→ qq.deliver
→ QQ
```

---

## 12.1 Moments 不删除

Moments 改为：

```text
Life 内部时间线 / Admin 可观察历史
```

流程可变成：

```text
Life Event
→ Moment 持久化
→ 判断是否值得主动联系
→ Proactive message
→ qq.deliver
```

用户不再通过 Web Moments 页面查看。

---

## 12.2 主动消息必须走统一 Delivery

禁止：

```text
Life → QQ Client
```

必须：

```text
Life
→ assistant message
→ qq.deliver
```

这样共享：

- outbox
- retry
- delivery log
- media
- metrics
- Admin 观察
- 失败处理

---

## 12.3 主动消息冲突控制

沿用 / 加强当前：

- 用户正在发消息时不要插话
- ReplyBatch 正在 generating 时推迟主动消息
- 静默时段
- 睡眠状态
- daily cap
- quiet gap
- 最近话题去重
- 同 candidate 去重

新增：

```text
QQ pending delivery
```

作为冲突判断之一。

---

# 13. P6：Web Admin 收敛

最终 Web 仅保留：

```text
/admin/*
```

保留：

- Overview
- Models
- Persona
- Memory / Ombre
- Sticker
- Media
- Chat History
- Voice
- Life
- Proactive
- Metrics
- Logs
- Storage
- Backup
- MCP
- Web Search
- System Settings

---

# 14. 删除普通 Web Chat

删除或停止构建：

```text
packages/web/src/App.tsx
ChatHeader
Composer
MessageItem 普通聊天 UI
useChat
chatViewState
composerDraft
messageSync
NotificationBridge
pushApi
pushToggle
visibilitySync
serviceWorkerUpdate
```

根据实际依赖逐个清理，不允许一次性删除后再到处补编译错误。

---

# 15. 删除 PWA

删除：

```text
public/sw.js
public/manifest.webmanifest
PWA icons（若 Admin 不再需要）
serviceWorker 注册
Web Push subscription UI
```

`main.tsx` 移除 Service Worker 注册逻辑。

---

# 16. 删除 Server Browser Push

最终移除：

```text
packages/server/src/core/push.ts
/api/push/*
push.reply
PushSubscriptionRepo
push subscription migration
VAPID settings
```

执行前先确认：

- 已没有其他模块依赖 PushService
- Admin 不再使用 push 状态
- 测试已改为 qq.delivery

---

# 17. Admin 增加 QQ 页面

新增：

```text
/admin/qq
```

显示：

### 状态
- QQ Bot enabled
- Credential configured
- 最近 inbound event
- 最近 outbound
- 最近成功
- 最近失败
- pending delivery 数
- retry 数
- failed 数

### 操作
- 测试 API
- 测试发送
- 重试单条 delivery
- 查看安全错误摘要

### 禁止
- 显示 App Secret
- 显示完整 Token
- 显示签名 Secret

---

# 18. Metrics

新增指标：

```text
qq.inbound.received
qq.inbound.duplicate
qq.inbound.invalid_signature
qq.inbound.accepted

qq.outbound.sent
qq.outbound.retry
qq.outbound.failed
qq.outbound.latency

qq.media.upload_success
qq.media.upload_failed

qq.proactive.sent
qq.proactive.failed
```

Admin Metrics 页面增加 QQ 分类。

---

# 19. 日志

建议 error source：

```text
qq.verify
qq.inbound
qq.auth
qq.send
qq.media
qq.delivery
```

日志只保存：

- event id
- message id
- HTTP status
- error code
- conversation 安全摘要
- retry count

不保存：

- Secret
- access token
- 完整签名
- 用户隐私消息正文（除非现有 message DB 本来就需要）

---

# 20. 配置迁移

## 20.1 新配置

加入 `.env.example`：

```text
QQ_BOT_ENABLED=false
QQ_APP_ID=
QQ_APP_SECRET=
QQ_CALLBACK_SECRET=
QQ_ENV=production
QQ_ALLOWED_USERS=
QQ_PROACTIVE_ENABLED=true
```

实际字段按当前腾讯官方文档调整。

---

## 20.2 废弃配置

QQ 稳定上线后逐步废弃：

```text
WEB_CHAT_TOKEN
SOOYA_PUSH_SUBJECT
VAPID / push 相关
NapCat / OneBot 相关
旧 qq-bridge 配置
```

`ADMIN_API_TOKEN` 保留。

---

# 21. 数据库 Migration

新增 migration：

1. `channel_event`
2. `channel_identity`
3. `channel_delivery`

不要直接改旧表结构完成全部需求。

新表独立可以：

- 降低回滚风险
- 便于迁移
- 不污染现有 Message schema
- 后续排查 QQ 发送状态更容易

---

# 22. 推荐目录最终形态

```text
packages/server/src/
├── channels/
│   └── qq/
│       ├── client.ts
│       ├── config.ts
│       ├── errors.ts
│       ├── inbound.ts
│       ├── mapping.ts
│       ├── media.ts
│       ├── outbound.ts
│       ├── types.ts
│       └── verify.ts
│
├── core/
│   ├── message-ingress.ts
│   ├── reply-coordinator.ts
│   ├── replier.ts
│   ├── proactive.ts
│   ├── mediaDirector.ts
│   ├── ombre-memory.ts
│   ├── life.ts
│   ├── life2/
│   └── ...
│
├── routes/
│   ├── qq.ts
│   ├── admin.ts
│   ├── health.ts
│   └── ...
│
└── db/
    ├── migrations.ts
    └── repos/
        ├── channel-event.repo.ts
        ├── channel-identity.repo.ts
        └── channel-delivery.repo.ts
```

不建设通用：

```text
ChannelManager
AdapterRegistry
MultiChannelBus
```

当前只有 QQ，避免过度设计。

---

# 23. 分阶段实施顺序

## PR 1：MessageIngress 解耦

内容：

- 新增 `MessageIngressService`
- `/api/messages` 改为调用 Service
- 测试补齐
- 行为保持完全兼容

验收：

```text
npm test
现有 chat tests 全绿
```

---

## PR 2：QQ Inbound

内容：

- QQ 配置
- Webhook / event route
- signature verify
- event idempotency
- identity mapping
- 文字消息进入 MessageIngress

验收：

```text
QQ 文字 → SOOYA user message → ReplyCoordinator
```

先允许回复仍停留 Server，不急着发 QQ。

---

## PR 3：QQ Outbound

内容：

- `channel_delivery`
- QQ Client
- `qq.deliver`
- Reply completion hook
- retry / idempotency

验收：

```text
QQ → SOOYA → QQ
```

完成最小闭环。

---

## PR 4：媒体

内容：

- 图片
- 语音
- Sticker
- 引用消息
- fallback

验收：

```text
QQ 文字
QQ 图片
SOOYA 图片回复
SOOYA 语音回复
SOOYA Sticker
```

---

## PR 5：Life / Proactive

内容：

- Proactive 生成 assistant message
- Moment 仍持久化
- `qq.deliver`
- 冲突控制
- quiet hours
- retry

验收：

```text
Life candidate
→ 主动 QQ 消息
```

---

## PR 6：Admin QQ 状态

内容：

- QQ status
- delivery queue
- failed / retry
- test send
- metrics

---

## PR 7：Web Chat / PWA 清理

删除：

- Web Chat
- PWA
- Browser Push
- Service Worker
- `/api/push/*`

Admin 保持可用。

---

## PR 8：遗留清理

删除：

- `qq-bridge`
- NapCat / OneBot 说明
- 个人 QQ 配置
- 无用 IPA/PWA 通道代码
- 无用 E2E

保留仍需要的数据迁移工具，直到确定无需回滚。

---

# 24. 测试要求

## 单元测试

### MessageIngress
- duplicate
- concurrent
- replyTo
- image content
- invalid content
- transaction rollback

### QQ Verify
- valid signature
- invalid signature
- expired timestamp
- replay

### QQ Mapping
- first bind
- existing bind
- unauthorized user
- group mapping

### QQ Delivery
- success
- timeout
- 429
- 5xx
- permanent 4xx
- duplicate job
- restart recovery

### QQ Media
- image
- audio
- unsupported format
- upload failure

---

# 25. 集成测试

建立 QQ mock server：

```text
SOOYA
↔ Mock QQ API
```

必须覆盖：

```text
event
→ ingress
→ reply
→ delivery
```

不要在 CI 中依赖真实 QQ 平台。

---

# 26. E2E 验收

上线前手工验收：

- [ ] QQ 发文字，SOOYA 正常回复
- [ ] 快速连发两条不会生成两次冲突回复
- [ ] 重复 QQ event 不重复回复
- [ ] Server 重启后待发消息继续发送
- [ ] QQ API 临时失败自动重试
- [ ] 已成功消息不会重复发送
- [ ] Ombre recall 正常
- [ ] Ombre commit 正常
- [ ] Director 正常
- [ ] 图片回复正常
- [ ] TTS 正常
- [ ] Sticker 正常
- [ ] Life 状态正常
- [ ] Life 主动消息正常
- [ ] 用户发消息时主动消息不会抢占
- [ ] Admin 可查看聊天记录
- [ ] Admin 可查看 QQ 状态
- [ ] Admin 可查看失败 delivery
- [ ] Web 普通聊天入口不存在
- [ ] PWA 不再注册 Service Worker
- [ ] Browser Push 已完全下线
- [ ] 不依赖 NapCat
- [ ] 不依赖 OneBot
- [ ] 不依赖旧 qq-bridge

---

# 27. 部署

不要直接覆盖线上。

建议：

```text
/opt/sooya/src
→ build
→ new release dir
→ migration
→ preflight
→ switch /opt/sooya/current
→ restart
→ health check
```

沿用现有 release / rollback 体系。

---

# 28. 上线顺序

推荐灰度：

## 阶段 A
QQ Bot 接入，但：

```text
QQ_BOT_ENABLED=true
QQ_PROACTIVE_ENABLED=false
```

只测试用户主动发消息。

## 阶段 B

开启：

```text
QQ_PROACTIVE_ENABLED=true
```

验证 Life 主动消息。

## 阶段 C

确认稳定后删除：

```text
PWA Chat
Browser Push
qq-bridge
```

---

# 29. 回滚方案

必须满足：

```text
数据库 migration 向前兼容
旧 Server 看不懂新表也不会出错
```

如果 QQ 版本失败：

1. 停止新版本
2. `/opt/sooya/current` 切回上一 release
3. 启动上一版本
4. 新增 `channel_*` 表保留，不删除
5. 不回滚 Ombre 数据
6. 不删除消息数据

不要在回滚脚本里清空 delivery / event 表。

---

# 30. 安全要求

- QQ Secret 只存在服务器环境变量
- Webhook 必须校验来源
- 所有 inbound event 做 replay protection
- 只允许授权 QQ 用户
- Admin 和 QQ 使用完全不同认证
- Admin Token 不可用于 QQ webhook
- QQ Token 不可用于 Admin
- 日志自动脱敏
- 不允许在 `/api/admin/export` 导出 QQ Secret
- 不允许备份包携带实时 access token

---

# 31. 实施完成后的最终数据流

## 普通回复

```text
QQ User
↓
QQ Event
↓
verify
↓
channel_event 幂等
↓
QQ inbound adapter
↓
MessageIngressService
↓
MessageRepo
↓
ReplyBatch
↓
ReplyCoordinator
↓
Replier
├─ Ombre recall
├─ Director
├─ Tool
├─ Media
└─ Voice
↓
Assistant Message
↓
Ombre commit
↓
qq.deliver
↓
channel_delivery
↓
QQ API
↓
QQ User
```

---

## Life 主动消息

```text
Life / Scheduler
↓
Candidate
↓
ProactiveComposer
↓
Moment
↓
Assistant Message
↓
qq.deliver
↓
QQ User
```

---

## Admin

```text
Browser
↓
/admin/*
↓
Admin API
↓
SOOYA Server

只管理，不聊天
```

---

# 32. 最终验收定义

项目完成后，SOOYA 必须满足：

> **服务器是唯一主脑，QQ 官方 Bot 是唯一消息通道，Web 只是后台控制室。**

同时：

- 不再需要 IPA 才能运行 SOOYA
- 不再需要 PWA 才能聊天
- 不再需要 NapCat / OneBot
- 不再需要个人 QQ 登录
- 不再需要额外 QQ bridge
- QQ 临时异常不会导致消息永久丢失
- Server 重启后 delivery 可恢复
- Life 可以自然主动联系用户
- Ombre 继续承担长期记忆
- 现有 Director / Media / Voice / Tool 能力全部继续工作

---

# 33. AI 实施约束

交给 AI / Codex / DSH 执行时必须遵守：

1. 先从 `/opt/sooya/src` 创建新分支。
2. 每个阶段独立 commit。
3. 不直接修改线上 `/opt/sooya/current`。
4. 不读取、打印、提交 `.env` Secret。
5. 每次 PR 必须跑对应单测。
6. 不允许为了 QQ 接入重写 ReplyCoordinator。
7. 不允许把 QQ 协议逻辑塞进 Replier。
8. 不允许把 QQ API 调用写进 ReplyCoordinator。
9. 必须使用 durable `qq.deliver`。
10. 必须做 inbound event 幂等。
11. 必须做 outbound delivery 幂等。
12. Life 主动消息必须走同一 delivery。
13. QQ 稳定前不得删除旧数据或迁移工具。
14. 最终删除 PWA / Push / NapCat / OneBot 依赖。
15. 所有 CI 全绿后才允许切换 release。

---

**实施总原则：保留 SOOYA 的脑，替换她的嘴和耳朵。**
