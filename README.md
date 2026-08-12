# SOOYA

> 单用户、长期连续、可自托管的私人 AI 伙伴。

SOOYA 不是一个多会话 ChatGPT 克隆，也不是把模型 API 套进聊天框的 Demo。

它围绕一条长期存在的私人关系构建：**会聊天、会记忆、会主动开口、会感知图片、会发送表情/图片/语音，也能通过 MCP 使用外部工具。**

打开页面后，你面对的始终是同一个 SOOYA，同一条连续聊天，以及一套会随着相处持续积累的上下文。

```text
你
 ↓
SOOYA
 ├─ 聊天与上下文
 ├─ Ombre Brain 长期记忆
 ├─ Life / 主动消息
 ├─ Vision / Web Search
 ├─ Media Director
 │   ├─ 表情包
 │   ├─ 图片生成
 │   └─ 语音
 └─ MCP Host
     └─ 外部工具与服务
```

## 现在能做什么

### 💬 一条真正连续的聊天

- 单用户、单人格、单主会话
- SSE 流式回复与断线补偿
- 消息持久化、撤回、历史加载
- 回复 revision fencing，旧任务不会覆盖更新后的回复
- 移动端、桌面端和 PWA

SOOYA 的目标不是管理几十个聊天窗口，而是让一次关系可以持续很久。

### 🧠 Ombre Brain 长期记忆

默认长期记忆后端是 **Ombre Brain**。

SOOYA 不再把记忆当作“每轮塞几条数据库记录到 Prompt”这么简单，而是把记忆生命周期拆开：

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

聊天阶段和主动消息阶段默认只允许读取记忆。写入发生在最终回复确认完成之后，避免“模型准备说什么”和“用户真正看到什么”产生偏差。

Ombre 以独立 MCP Server 运行，SOOYA 负责连接、工具策略、调用和生命周期编排。生产部署说明见 [deploy/ombre/README.md](deploy/ombre/README.md)。

### 🌱 她也有自己的生活

SOOYA 有独立的 Life / Proactive 系统，不需要等你每次先发消息。

它可以维护当前状态、近期经历和主动开口条件，让“她现在在做什么”和“她为什么想给你发消息”成为系统的一部分，而不是让聊天模型临时编一个背景。

管理后台的 **「她的生活」** 页面可以观察这些状态。

### 🎭 Media Director

媒体输出不再依赖主模型在回复末尾偷偷拼一串特殊标记。

现在由独立的 **Media Director** 负责媒体决策和短结构化任务，包括：

- 是否需要发送表情包
- 语音内容的口语化处理
- 图片生成提示词扩写
- 媒体能力失败时的安全降级

主回复负责“说什么”，Media Director 负责“怎么表达”。两条链路分开，媒体失败不会把整条聊天拖下水。

### 👀 图片、表情、语音与联网搜索

SOOYA 当前支持：

- 图片理解 / Vision
- 图片生成
- 本地表情包图库与 AI 分析
- TTS 语音消息
- Web Search
- 图片、音频和其他媒体文件的持久化

这些能力分别配置，可以使用不同模型，也可以在缺失时独立降级。

### 🔌 通用 MCP Host

SOOYA 本身是一个 **通用 MCP Host**，不是“写死 Ombre 的客户端”。

核心链路：

```text
McpManager
   ↓
McpConnection
   ↓
ToolRegistry
   ↓
ToolPolicy
   ↓
ToolCallRuntime
   ↓
模型工具调用
```

目前支持：

- `streamable-http`
- `sse`
- 多 MCP Server
- Bearer Token 从环境变量读取
- 工具动态发现与刷新
- Server 连接状态与自动重连
- 工具超时、轮数、结果大小限制
- required / best-effort Server
- 按阶段和风险等级控制工具权限

工具风险分为：

```text
read
write
external_side_effect
destructive
maintenance
```

正常 `reply` 和 `proactive` 阶段默认只开放安全读取能力。写入、外部副作用和维护工具需要对应阶段明确授权。

MCP Server 定义放在 `config/mcp.json`：

```json
{
  "servers": {
    "ombre": {
      "enabled": true,
      "transport": "streamable-http",
      "url": "http://127.0.0.1:18001/mcp",
      "auth": {
        "type": "bearer-env",
        "env": "OMBRE_MCP_TOKEN"
      },
      "required": false,
      "connectTimeoutMs": 10000,
      "toolTimeoutMs": 15000
    }
  }
}
```

**不要把 Token 写进 `mcp.json`。** `bearer-env` 只保存环境变量名，真实密钥放在 `.env` / systemd 环境中。

运行时可以通过 `MCP_CONFIG_PATH` 指向运维管理的配置文件。生产 release 布局会优先保留 `shared/config` 中的持久化配置。

### 🛠️ 管理中心

`/admin` 不是一个只有日志的调试页，目前可以管理和观察：

| 页面 | 用途 |
| --- | --- |
| 概览 | 系统状态与资源 |
| 助手配置 | 人设、表达和语音行为 |
| 模型配置 | Chat / Vision / Summary / Director / Embedding / Rerank / Image / TTS / Web Search |
| 双方头像 | 助手与用户头像 |
| 她的生活 | Life 状态与主动消息 |
| 内容管理 | 记忆、表情包、媒体、聊天记录 |
| MCP 服务 | Server 状态、连接测试、刷新工具、工具权限详情 |
| 存储治理 | 媒体清理与空间回收 |
| 运维与备份 | 后台任务、错误和备份 |

MCP 工具详情默认收起，日常只需要关注 Server 是否正常、工具数量和错误信息。

---

## 架构

```text
┌─────────────────────────────────────────────┐
│               React 19 / PWA                │
│        Chat UI             Admin UI         │
└──────────────────────┬──────────────────────┘
                       │ HTTP / SSE
┌──────────────────────▼──────────────────────┐
│                 Fastify Server              │
│                                             │
│  Conversation / Replier                    │
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
│      └─ Final visible stream                │
│                                             │
│  Media Director      Background Jobs        │
│  Media Storage       SQLite / Repositories  │
│  Backup / Recovery   Persistent Event Bus   │
└─────────────────────────────────────────────┘
```

模型工具调用使用统一的内部协议，不把核心回复链绑定到某一家模型厂商。隐藏工具轮次完成后，再进入最终可见的流式回复，因此用户不会看到模型内部的 ToolCall 往返。

---

## 快速开始

### 环境要求

- Node.js `>= 20.10.0`
- 推荐使用 **Node.js 22**，与当前 CI / 生产环境保持一致
- Linux / macOS
- 构建 `better-sqlite3` 需要可用的本地编译工具链

### 1. 安装

```bash
git clone <your-repo> sooya
cd sooya
npm ci
cp .env.example .env
chmod 600 .env
```

至少先设置管理后台 Token：

```env
ADMIN_API_TOKEN=换成一个足够长的随机字符串
```

如果服务会暴露到公网，再配置：

```env
WEB_CHAT_TOKEN=
CORS_ALLOWED_ORIGINS=
```

完整配置项都在 [.env.example](.env.example)，不要提交真实 `.env`。

### 2. 启动

生产构建：

```bash
npm run build
npm start
```

默认监听：

```text
http://127.0.0.1:8788
```

开发模式：

```bash
npm run dev:parallel
```

- Server: `8788`
- Vite: `5173`

### 3. 配置模型

打开：

```text
/admin/models
```

模型按能力拆分，不要求所有功能都使用同一个模型。

Chat 层目前支持包括：

- OpenAI Chat 风格协议
- OpenAI Responses 风格协议
- Anthropic Messages 风格协议
- OpenAI-compatible 服务

Vision、Summary、Media Director、Embedding、Rerank、Image、TTS 和 Web Search 都可以独立配置。

模型密钥由服务端保存，管理页面只返回是否已配置，不回传明文密钥。

### 4. 启动 Ombre Brain

默认：

```env
MEMORY_BACKEND=ombre
OMBRE_MCP_URL=http://127.0.0.1:18001/mcp
OMBRE_MCP_TOKEN=
```

完整的 Ombre 安装、固定版本和 loopback 部署方式见：

**[deploy/ombre/README.md](deploy/ombre/README.md)**

当前 `ombre` Server 默认 `required: false`。Ombre 暂时不可用时，基础聊天不会因为记忆服务离线而直接停止，但长期记忆能力会进入降级状态。

---

## MCP 配置

默认配置文件：

```text
config/mcp.json
```

可以添加其他 MCP Server，而不用为每个服务重新写一套客户端：

```json
{
  "servers": {
    "example": {
      "enabled": true,
      "transport": "streamable-http",
      "url": "http://127.0.0.1:9000/mcp",
      "auth": {
        "type": "bearer-env",
        "env": "EXAMPLE_MCP_TOKEN"
      },
      "required": false,
      "connectTimeoutMs": 10000,
      "toolTimeoutMs": 15000
    }
  }
}
```

然后在环境中提供：

```env
EXAMPLE_MCP_TOKEN=...
```

通用开关：

```env
MCP_CONNECT_ON_START=true
MCP_READ_ENABLED=true
MCP_WRITE_ENABLED=true
MCP_MAINTENANCE_ENABLED=true
MCP_TOOL_REFRESH_INTERVAL_MS=21600000
```

MCP Admin 页面可以查看连接状态、测试 Server、刷新工具，以及在需要时展开工具与权限详情。

---

## 数据与持久化

SOOYA 把用户拥有的数据保存在持久化目录，而不是 release 目录里。

主要包括：

- SQLite 数据库
- 媒体文件
- 模型 / 人格 / MCP 等配置
- 备份
- 运行期状态

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
npm test
npm run build
npm run package
npm run verify:release
```

完整生产部署说明：

**[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**

部署设计遵循一个简单原则：**公网入口和用户数据分开。** 公网通常只暴露 Nginx / App 所需入口，SQLite、配置、备份和本地 MCP 服务不应该直接暴露。

---

## 项目结构

```text
sooya/
├── packages/
│   ├── server/
│   │   └── src/
│   │       ├── agent/          Tool Registry / Policy / Runtime
│   │       ├── core/           回复、上下文、Life、记忆、媒体编排
│   │       ├── mcp/            通用 MCP Host
│   │       ├── providers/      模型、Embedding、Image、TTS 等适配器
│   │       ├── db/             SQLite、迁移与 repositories
│   │       ├── routes/         Chat / Admin / Media / Health API
│   │       └── backup/         备份与恢复
│   └── web/                    React 19 + Vite 6 前端
├── config/                     默认运行配置
├── deploy/                     systemd / nginx / Ombre / 部署脚本
├── docs/                       架构与运维文档
├── e2e/                        Playwright E2E
├── scripts/                    发布、校验、迁移等脚本
└── assets/                     内置资源
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
| `npm run test:e2e` | Playwright E2E |
| `npm run typecheck` | 全 workspace TypeScript 检查 |
| `npm run package` | 生成 release 包 |
| `npm run verify:release` | 校验 release 包 |
| `npm run migrate:ombre` | 执行旧 SOOYA 记忆到 Ombre 的迁移工具 |

Web 自身也有独立的 Vitest 测试：

```bash
npm run test -w @sooya/web
```

---

## 技术栈

### Server

- Node.js / TypeScript
- Fastify 5
- SQLite + better-sqlite3 (WAL)
- Zod
- Pino
- MCP TypeScript SDK
- Sharp
- Vitest

### Web

- React 19
- TypeScript
- Vite 6
- TanStack Virtual
- PWA
- Playwright

SOOYA 目前仍然刻意保持单用户架构。没有多租户、团队空间、RBAC 或复杂微服务层，这些并不是当前产品目标。

---

## 设计原则

**主回复优先。** 工具、媒体和后台维护不能轻易破坏用户真正看到的回复。

**记忆有生命周期。** 召回、写入和维护不是同一个动作，也不应该挤在一次模型调用里。

**MCP 保持通用。** Ombre 是第一个重要 MCP，但 Host 不围绕 Ombre 写死，未来服务应该通过注册、配置和策略接入。

**能力可以降级。** Vision、Image、TTS、Web Search、MCP 中任何一个不可用，都应该尽可能保住基础聊天链路。

**数据属于部署者。** 聊天、媒体、配置和备份都落在自托管环境里，release 更新不覆盖持久数据。

---

## 安全提示

- 不要提交 `.env`、API Key、MCP Token 或真实生产配置
- 公网部署请设置 `WEB_CHAT_TOKEN` 和 `ADMIN_API_TOKEN`
- MCP Token 使用 `bearer-env` 注入，不写入 `mcp.json`
- 不要把 SQLite、备份目录或本地 Ombre MCP 端口直接暴露到公网
- 外部副作用 / destructive 工具应保持严格 ToolPolicy，不要为了“方便”全局放开

---

## 文档

- [生产部署](docs/DEPLOYMENT.md)
- [Ombre Brain 部署](deploy/ombre/README.md)
- [API](docs/API.md)
- [数据库](docs/DATABASE.md)
- [已知限制](docs/LIMITATIONS.md)

---

## 项目状态

SOOYA 仍在持续开发中。内部结构、管理页面和工具协议可能继续调整。

如果你只是想找一个通用聊天 UI，这个项目会显得有点重；如果你想让一个 AI 在自己的服务器上长期存在、持续记住同一个人，并逐渐获得更多可控能力，这正是 SOOYA 要做的事。

## License

MIT
