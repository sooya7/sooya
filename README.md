# SOOYA

> 单用户、长期连续、可自托管的私人 AI 伙伴。

SOOYA 不是一个多会话 ChatGPT 克隆，也不是把模型 API 套进聊天框的 Demo。

它围绕一条长期存在的私人关系构建：**会聊天、会记忆、会主动开口、会感知图片、会发送表情/图片/语音，也能通过 MCP 使用外部工具。**

你面对的始终是同一个 SOOYA，同一条连续聊天，以及一套会随着相处持续积累的上下文。

> ### 先说清楚：聊天走 QQ 官方 Bot
>
> SOOYA 是**单通道**架构：
>
> - **QQ 官方 Bot 是唯一的用户聊天入口与消息出口。**
> - Web 端只有管理后台 `/admin` 和图库 `/gallery`，两者都由 Admin Token 保护。
> - 旧的 Web Chat、SSE 聊天接口、PWA 与浏览器推送已下线，`WEB_CHAT_TOKEN` 一并删除。
>
> 也就是说：**跑 SOOYA 需要一个 QQ 开放平台的机器人**（AppID / AppSecret / Bot Secret）。
> 只 `npm start` 而不配置 QQ，你会得到一个能用的管理后台，但没有任何聊天通道。
>
> 配置方法见 [3. 配置 QQ 通道](#3-配置-qq-通道)；完整接口清单见 [docs/API.md](docs/API.md)。

```text
你（QQ）
 ↓  官方 Bot webhook（Ed25519 签名校验 → 事件幂等 → 白名单）
SOOYA
 ├─ 聊天与上下文
 ├─ Ombre Brain 长期记忆
 ├─ Life / 主动消息
 ├─ Vision / Web Search
 ├─ Media Director
 │   ├─ 表情包
 │   ├─ 图片生成
 │   └─ 语音
 ├─ MCP Host
 │   └─ 外部工具与服务
 └─ Web 管理后台 / 图库（Admin Token）
```

## 现在能做什么

### 💬 一条真正连续的聊天

- 单用户、单人格、单主会话（固定 `conversation_id = "main"`，没有新建/切换会话）
- 入站：webhook 签名校验 → 事件幂等 → 统一 `MessageIngress`
- 出站：durable outbox，失败自动重试，进程崩溃后由兜底扫描补投
- 连续消息合并与可打断生成：你连发几条，她按最终的那一版回
- 回复 revision fencing：旧任务永不覆盖更新后的回复
- 消息持久化、撤回、历史检索

SOOYA 的目标不是管理几十个聊天窗口，而是让一次关系可以持续很久。

### 🧠 Ombre Brain 长期记忆

默认长期记忆后端是 **Ombre Brain**。

SOOYA 不把记忆当作「每轮塞几条数据库记录进 Prompt」，而是把记忆生命周期拆开：

```text
长时间未互动
   ↓
breath / 记忆浮现
   ↓
当前对话
   ↓
只读记忆工具参与回复
   ↓
最终回复发布完成
   ↓
后台 memory_commit
   ↓
周期性 dream / 维护整理
```

聊天阶段和主动消息阶段默认只允许**读取**记忆。写入发生在最终回复确认完成之后，避免「模型准备说什么」和「用户真正看到什么」产生偏差。

Ombre 以独立 MCP Server 运行，SOOYA 负责连接、工具策略、调用和生命周期编排。部署见 [deploy/ombre/README.md](deploy/ombre/README.md)。

### 🌱 她也有自己的生活

SOOYA 有独立的 Life / Proactive 系统，不需要等你每次先发消息。

它维护当前状态、近期经历和主动开口条件，让「她现在在做什么」和「她为什么想给你发消息」成为系统的一部分，而不是让聊天模型临时编一个背景。

管理后台的 **「她的生活」** 页面可以观察这些状态，包括她为什么还没主动开口。

### 🎭 Media Director

媒体输出不依赖主模型在回复末尾偷偷拼一串特殊标记。

由独立的 **Media Director** 负责媒体决策和短结构化任务：

- 是否需要发送表情包
- 语音内容的口语化处理
- 图片生成提示词扩写
- 媒体能力失败时的安全降级

主回复负责「说什么」，Media Director 负责「怎么表达」。两条链路分开，媒体失败不会把整条聊天拖下水。

### 👀 图片、表情、语音与联网搜索

- 图片理解 / Vision
- 图片生成（含参考图与视觉时间一致性）
- 本地表情包图库与 AI 分析
- TTS 语音消息
- Web Search
- 图片、音频和其他媒体文件的持久化

这些能力分别配置，可以使用不同模型，也可以在缺失时独立降级。

### 🌍 世界上下文

位置与天气默认开启。天气使用免密钥的 Open-Meteo，因此会有到 `open-meteo.com` 的出站请求；需要完全离线部署时把 `WORLD_CONTEXT_ENABLED` / `LOCATION_MODEL_ENABLED` / `WEATHER_ENABLED` 一起设为 `false`。

### 🔌 通用 MCP Host

SOOYA 本身是一个 **通用 MCP Host**，不是「写死 Ombre 的客户端」。

```text
McpManager → McpConnection → ToolRegistry → ToolPolicy → ToolCallRuntime → 模型工具调用
```

目前支持：

- `streamable-http` 与 `sse`
- 多 MCP Server、required / best-effort
- Bearer Token 从环境变量读取
- 工具动态发现与刷新、连接状态与自动重连
- 工具超时、轮数、结果大小限制
- 按阶段和风险等级控制工具权限

工具风险分为 `read` / `write` / `external_side_effect` / `destructive` / `maintenance`。正常 `reply` 和 `proactive` 阶段默认只开放安全读取能力；写入、外部副作用和维护工具需要对应阶段明确授权。

MCP Server 定义放在 `config/mcp.json`：

```json
{
  "servers": {
    "ombre": {
      "enabled": true,
      "transport": "streamable-http",
      "url": "http://127.0.0.1:18001/mcp",
      "auth": { "type": "bearer-env", "env": "OMBRE_MCP_TOKEN" },
      "required": false,
      "connectTimeoutMs": 10000,
      "toolTimeoutMs": 15000
    }
  }
}
```

**不要把 Token 写进 `mcp.json`。** `bearer-env` 只保存环境变量名，真实密钥放在 `.env` / systemd 环境中。

运行时可以用 `MCP_CONFIG_PATH` 指向运维管理的配置文件；生产 release 布局会优先使用 `shared/config` 中的持久化配置。

### 🛠️ 管理中心

`/admin` 不是只有日志的调试页：

| 页面 | 用途 |
| --- | --- |
| 概览 | 运行状态与资源 |
| QQ 通道 | 官方 Bot 通道状态与投递情况（Secret 永不显示） |
| 助手配置 | 人设与表达方式 |
| 双方头像 | 助手与用户头像 |
| 她的生活 | 此刻在做什么与主动开口 |
| 模型配置 | Chat / Vision / Summary / Director / Embedding / Rerank / Image / TTS / Web Search |
| 内容管理 | 记忆、表情包、媒体、聊天记录 |
| MCP 服务 | 连接、工具与策略观测 |
| 存储治理 | 媒体清理与空间回收 |
| 运维与备份 | 后台任务、错误和备份 |

MCP 工具详情默认收起，日常只需要关注 Server 是否正常、工具数量和错误信息。

---

## 架构

```text
┌──────────────────────┐   ┌──────────────────┐
│   QQ 官方 Bot 平台    │   │   React 19 Web   │
│  （唯一聊天通道）      │   │ Admin / Gallery  │
└──────────┬───────────┘   └────────┬─────────┘
           │ webhook (Ed25519)      │ HTTP + Admin Token
┌──────────▼────────────────────────▼─────────┐
│                 Fastify Server              │
│                                             │
│  MessageIngress / ReplyCoordinator          │
│      │                                      │
│      ├─ Context Builder                     │
│      │   ├─ Persona                         │
│      │   ├─ Recent Messages                 │
│      │   ├─ Life / World Context            │
│      │   └─ Ombre Memory                    │
│      │                                      │
│      ├─ Provider-neutral Model Turns        │
│      │                                      │
│      ├─ ToolCallRuntime                     │
│      │   └─ ToolPolicy / ToolRegistry       │
│      │       └─ McpManager                  │
│      │           ├─ Ombre Brain             │
│      │           └─ Other MCP Servers       │
│      │                                      │
│      └─ QQ Delivery（durable outbox）        │
│                                             │
│  Media Director      Background Jobs        │
│  Media Storage       SQLite / Repositories  │
│  Backup / Recovery   Persistent Event Bus   │
└─────────────────────────────────────────────┘
```

模型工具调用使用统一的内部协议，不把核心回复链绑定到某一家模型厂商。隐藏工具轮次完成后再产出最终回复，因此用户不会看到模型内部的 ToolCall 往返。

---

## 快速开始

### 环境要求

- Node.js `>= 20.10.0`，推荐 **Node.js 22**（与 CI / 生产一致）
- Linux / macOS
- 构建 `better-sqlite3` 需要可用的本地编译工具链
- 一个 QQ 开放平台机器人（聊天通道，见第 3 步）

### 1. 安装

```bash
git clone https://github.com/sooya7/sooya.git
cd sooya
npm ci
cp .env.example .env
chmod 600 .env
```

### 2. 配置访问控制

```env
# 必填。为空时所有 admin 接口一律返回 503（fail closed）
ADMIN_API_TOKEN=换成一个足够长的随机字符串
```

暴露到公网时再配：

```env
# 允许的浏览器来源；留空表示仅同源
CORS_ALLOWED_ORIGINS=
# 谁有权设置 X-Forwarded-For。req.ip 决定限流分桶，不能无条件信任。
#   loopback（默认）= 同机 Nginx，对应 deploy/nginx.conf.example
#   false / 跳数 / CIDR 列表 也都支持
TRUST_PROXY=loopback
```

### 3. 配置 QQ 通道

**这一步是必需的**，否则 SOOYA 没有聊天入口。

在 [QQ 开放平台](https://q.qq.com) 创建机器人，取得 `AppID`、`AppSecret` 和 `Bot Secret`，把回调地址填成 `https://<你的域名>/api/qq/callback`，然后：

```env
QQ_BOT_ENABLED=true
QQ_APP_ID=你的 AppID
# OAuth 换 Access Token（出站 API）
QQ_APP_SECRET=你的 AppSecret
# 开放平台 Bot Secret：webhook Ed25519 签名校验（回调验证与事件推送共用）
QQ_CALLBACK_SECRET=你的 BotSecret
# 允许绑定的 QQ 用户 openid 白名单（逗号分隔）。留空 = 不接受任何用户
QQ_ALLOWED_USERS=你的 openid
```

要点：

- 三个 Secret **只存在于服务器环境变量**：不进 git、不进数据库导出、不打印日志。管理后台只显示「已配置 / 未配置」。
- `QQ_ALLOWED_USERS` 是**授权**白名单，不是认证手段。第一个通过白名单的用户绑定为 owner，之后其他用户一律拒绝，普通消息无法改变 owner。
- `QQ_BOT_ENABLED=false` 时 `/api/qq/callback` 一律返回 404，不暴露回调路径是否存在。
- **不知道自己的 openid？** 先把 `QQ_ALLOWED_USERS` 留空并启动，给机器人发一条消息，再到管理后台 → QQ 通道 → 事件列表里读出被拒绝事件的 openid，填回配置后重启。

### 4. 启动

```bash
npm run build
npm start
```

默认监听 `http://127.0.0.1:8788`，管理后台在 `/admin`。

开发模式：

```bash
npm run dev:parallel   # Server 8788 + Vite 5173
```

### 5. 配置模型

打开 `/admin`（模型配置）。模型按能力拆分，不要求所有功能都用同一个模型。

Chat 层支持：

- OpenAI Chat 风格协议
- OpenAI Responses 风格协议
- Anthropic Messages 风格协议
- 其他 OpenAI-compatible 服务

Vision、Summary、Media Director、Embedding、Rerank、Image、TTS 和 Web Search 都可以独立配置。

模型密钥由服务端保存，管理页面只返回是否已配置，不回传明文密钥。也可以让 `models.json` 只存环境变量名（`apiKeyEnv`），密钥完全留在环境里。

### 6. 启动 Ombre Brain

```env
MEMORY_BACKEND=ombre
OMBRE_MCP_URL=http://127.0.0.1:18001/mcp
OMBRE_MCP_TOKEN=
```

完整的安装、固定版本与 loopback 部署方式见 **[deploy/ombre/README.md](deploy/ombre/README.md)**。

`ombre` Server 默认 `required: false`：Ombre 暂时不可用时基础聊天不会停止，但长期记忆能力会进入降级状态。

---

## 数据与持久化

SOOYA 把用户拥有的数据保存在持久化目录，而不是 release 目录里：SQLite 数据库、媒体文件、模型 / 人格 / MCP 配置、备份、运行期状态。

生产部署采用 release + shared 结构：

```text
/opt/sooya/
├── current -> releases/<timestamp>
├── releases/
└── shared/
    ├── data/
    └── config/
```

升级只替换 release，用户数据留在 `shared`。

---

## 生产部署

项目提供 systemd、Nginx、release 打包、升级、回滚、备份和恢复流程。

发布前建议至少执行：

```bash
npm ci
npm run typecheck
npm run check:architecture
npm run check:hotspots
npm test
npm run build
npm run package
npm run verify:release
```

完整说明见 **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**。

部署设计遵循一个原则：**公网入口和用户数据分开。** 公网只暴露 Nginx / App 所需入口；SQLite、配置、备份和本地 Ombre MCP 端口都不应直接暴露。

---

## 项目结构

```text
sooya/
├── packages/
│   ├── server/
│   │   └── src/
│   │       ├── agent/         Tool Registry / Policy / Runtime
│   │       ├── channels/      QQ 官方 Bot 单通道（签名、入站、出站 outbox）
│   │       ├── core/          回复、上下文、Life、记忆、媒体编排
│   │       ├── mcp/           通用 MCP Host
│   │       ├── providers/     模型、Embedding、Image、TTS 等适配器
│   │       ├── db/            SQLite、迁移与 repositories
│   │       ├── routes/        Admin / Media / Health / QQ webhook API
│   │       └── backup/        备份与恢复
│   └── web/                   React 19 + Vite 6 管理后台与图库
├── config/                    默认运行配置
├── deploy/                    systemd / nginx / Ombre / 部署脚本
├── docs/                      架构与运维文档
├── e2e/                       Playwright E2E
├── scripts/                   发布、校验、迁移等脚本
└── assets/                    内置资源
```

---

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 构建 Web 后启动 Server watch |
| `npm run dev:parallel` | 同时启动 Server 和 Vite 开发服务 |
| `npm run build` | 构建 Server + Web |
| `npm start` | 启动生产 Server |
| `npm test` | Server 测试 |
| `npm run test -w @sooya/web` | Web 测试 |
| `npm run test:e2e` | Playwright E2E |
| `npm run typecheck` | 全 workspace TypeScript 检查 |
| `npm run check:architecture` | 模块边界检查 |
| `npm run check:hotspots` | 热点文件体积棘轮 |
| `npm run package` | 生成 release 包 |
| `npm run verify:release` | 校验 release 包 |
| `npm run migrate:ombre` | 旧 SOOYA 记忆到 Ombre 的迁移工具 |

---

## 技术栈

**Server** — Node.js / TypeScript、Fastify 5、SQLite + better-sqlite3 (WAL)、Zod、Pino、MCP TypeScript SDK、Sharp、Vitest

**Web** — React 19、TypeScript、Vite 6、TanStack Virtual、Playwright

SOOYA 刻意保持单用户架构。没有多租户、团队空间、RBAC 或复杂微服务层，这些不是当前产品目标。

---

## 设计原则

**主回复优先。** 工具、媒体和后台维护不能轻易破坏用户真正看到的回复。

**记忆有生命周期。** 召回、写入和维护不是同一个动作，也不应该挤在一次模型调用里。

**MCP 保持通用。** Ombre 是第一个重要 MCP，但 Host 不围绕 Ombre 写死。

**能力可以降级。** Vision、Image、TTS、Web Search、MCP 中任何一个不可用，都应该尽可能保住基础聊天链路。

**数据属于部署者。** 聊天、媒体、配置和备份都落在自托管环境里，release 更新不覆盖持久数据。

**坏了就不要装作没坏。** 数据库无法打开时拒绝启动而不是建一个空库；损坏且没有可验证备份时 fail closed；能力缺失如实上报而不是假装可用。

---

## 安全提示

- 不要提交 `.env`、API Key、MCP Token 或真实生产配置
- 公网部署必须设置 `ADMIN_API_TOKEN`（为空时所有 admin 接口返回 503）
- 按实际拓扑设置 `TRUST_PROXY`。保持默认 `loopback` 即可对应同机 Nginx；不要设成 `true`，除非确认没有不受信来源能直连该端口——那等于让调用方自选限流分桶
- QQ 的 `QQ_APP_SECRET` / `QQ_CALLBACK_SECRET` 只放环境变量，并配置 `QQ_ALLOWED_USERS` 白名单
- MCP Token 使用 `bearer-env` 注入，不写入 `mcp.json`
- 不要把 SQLite、备份目录或本地 Ombre MCP 端口直接暴露到公网
- 外部副作用 / destructive 工具应保持严格 ToolPolicy，不要为了「方便」全局放开

---

## 文档

- [生产部署](docs/DEPLOYMENT.md)
- [Ombre Brain 部署](deploy/ombre/README.md)
- [API](docs/API.md)
- [数据库](docs/DATABASE.md)
- [已知限制](docs/LIMITATIONS.md)
- [架构](docs/ARCHITECTURE.md)

---

## 项目状态

SOOYA 仍在持续开发中。内部结构、管理页面和工具协议可能继续调整。

如果你只是想找一个通用聊天 UI，这个项目会显得有点重；如果你想让一个 AI 在自己的服务器上长期存在、持续记住同一个人，并逐渐获得更多可控能力，这正是 SOOYA 要做的事。

## License

MIT
