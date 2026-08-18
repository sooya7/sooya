# SOOYA API 文档

默认基址：`http://127.0.0.1:8788`。

自 QQ 单通道架构起，**QQ 官方 Bot 是唯一用户聊天入口与消息出口，Web 只保留 Admin / Gallery 管理能力**。旧 Web Chat、SSE、PWA、Browser Push 与用户态 HTTP Chat API 已下线。

## 鉴权

| 凭据 | 保护范围 | 未配置时 |
| --- | --- | --- |
| `ADMIN_API_TOKEN` | `/api/admin/*` 与 Admin 媒体读取 | 全部拒绝（fail-closed） |
| QQ App Secret / Callback Secret | `/api/qq/callback` | QQ 通道不可用 |

Admin 请求使用：

```http
X-Admin-Token: <ADMIN_API_TOKEN>
```

也接受标准 `Authorization: Bearer <ADMIN_API_TOKEN>`。管理令牌不支持 query / fragment 传递。

`/health/*` 不需要令牌，供部署脚本和容器探针使用。API Key 与 QQ Secret 永不通过 Admin API 返回浏览器。

## QQ 通道

### `POST /api/qq/callback`

腾讯 QQ 官方 Bot Webhook。服务端校验平台签名，完成事件幂等、QQ 身份绑定与消息入站，然后交给统一 `MessageIngress` / `ReplyCoordinator`。

出站统一写入 durable `qq.deliver`，由 QQ Delivery Service 投递文字、图片、语音、表情与文件。

QQ 运维状态通过 `/api/admin/qq/*` 查看，Secret 只显示“已配置 / 未配置”，不会回传原值。

## 健康检查

| 端点 | 用途 |
| --- | --- |
| `GET /health/live` | 进程 liveness |
| `GET /health/ready` | 数据库、媒体目录、任务队列 readiness |
| `GET /health/deep` | 深度健康检查 |
| `GET /api/capabilities` | 非敏感能力概览 |

## Admin API

所有 `/api/admin/*` 都需要 `ADMIN_API_TOKEN`。

### 模型与能力

- `GET /api/admin/models`
- `PUT /api/admin/models`
- `POST /api/admin/models/:slot/test`
- `POST /api/admin/models/:slot/discover`
- `GET /api/admin/capabilities`
- 模型库 / Web Search / TTS / Image 等管理接口

模型 API Key 只在服务器保存，返回值仅暴露 `apiKeyConfigured` 等布尔状态。

### QQ 通道

- `GET /api/admin/qq/status`
- `GET /api/admin/qq/events`
- `GET /api/admin/qq/deliveries`
- `GET /api/admin/qq/errors`
- `POST /api/admin/qq/test-send`
- `POST /api/admin/qq/deliveries/:id/retry`

### 人格、参考图与 Life

- 人格配置与头像
- SOOYA 固定参考图槽位
- Life 状态、计划、地点、城市、天气
- 主动消息策略与观察数据

这些是 Admin 管理面，不再提供用户态 `/api/life*` 浏览器接口。

### 内容、记忆与媒体

Admin 可管理聊天历史与搜索、Ombre / Memory 状态、表情包、媒体与图库、回收站 / 安全清理、审计日志。

媒体字节读取：

```text
GET /api/media/:id
GET /api/media/:id/meta
```

这两个端点现在属于 **Admin-only** 读取面，使用 `ADMIN_API_TOKEN`。QQ 投递不经过 HTTP 媒体接口，而是服务器内部直接读取 `MediaStore`。

`POST /api/media` 已删除。Admin 上传头像、参考图、表情等走各自的 `/api/admin/*` 上传接口。

### 系统与备份

Admin 提供系统状态、错误日志、任务、存储策略、完整备份 / 恢复及 IPA 迁移相关能力。

## 已删除的旧 Web Chat API

以下端点不再属于生产 API：

```text
/api/conversation
/api/messages*
/api/reply-batches/*
/api/stream
/api/events
/api/moments*
/api/thoughts/*
/api/settings/voice*
/api/voice-generations/*
/api/life
/api/life/locations
/api/life/world
/api/life/presence
POST /api/media
```

对应的 `WEB_CHAT_TOKEN` 也已删除。测试目录中可能存在测试专用兼容路由，仅用于驱动核心回归测试，不会编译进生产 Server。

## 错误约定

| 状态码 | 含义 |
| --- | --- |
| 400 | 参数或协议校验失败 |
| 401 / 403 | Admin 凭据缺失或错误 |
| 404 | 资源或已下线路由不存在 |
| 413 | 上传或请求体超限 |
| 416 | Range 越界 |
| 429 | 频率限制 |
| 500 / 502 | 内部或上游服务错误 |
| 503 | Admin 未配置或服务暂不可用 |
