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
- 模型库 / Web Search / TTS / Image / Video 等管理接口

模型 API Key 只在服务器保存，返回值仅暴露 `apiKeyConfigured` 等布尔状态。

### 视频生成（文生视频 / 图生视频）

视频生成是**异步任务**：提交后立刻返回任务，服务端在后台创建上游任务、轮询进度并把成片下载落库；调用方轮询任务状态，完成后通过 `task.media.url` 读取文件。上游协议在 管理后台 → 模型配置 → 视频生成模型 里配置，走 OpenAI Videos 协议（`/videos`），OpenAI 官方与 NewAPI 等兼容网关均可。

| 端点 | 用途 |
| --- | --- |
| `GET /api/admin/video` | 能力状态、已脱敏的模型配置、任务计数 |
| `PUT /api/admin/video` | 更新视频模型配置（`{ "model": { ... } }`） |
| `POST /api/admin/video/generations` | 创建任务，返回 `202 { task }` |
| `GET /api/admin/video/generations` | 任务列表，支持 `limit` / `offset` / `status` |
| `GET /api/admin/video/generations/:id` | 单个任务与进度 |
| `POST /api/admin/video/generations/:id/cancel` | 取消任务（同时尽力取消上游） |
| `DELETE /api/admin/video/generations/:id` | 删除已结束任务的记录（成片仍保留在媒体库） |

创建任务接受 JSON 或 multipart：

| 字段 | 说明 |
| --- | --- |
| `prompt` | 必填，视频描述，最多 2000 字符 |
| `image` | multipart 文件字段；提供后即为图生视频（首帧） |
| `imageMediaId` | 已存在的媒体 id（先用 `POST /api/admin/media` 上传） |
| `imageUrl` | 公网图片地址，服务端经 SSRF 校验后下载 |
| `durationSec` | 可选，1–60，覆盖默认时长 |
| `size` | 可选，WxH，如 `1280x720` / `720x1280` |

`image`、`imageMediaId`、`imageUrl` 三者只能提供一个；都不提供即为文生视频。

```bash
# 文生视频
curl -X POST http://127.0.0.1:8788/api/admin/video/generations \
  -H "X-Admin-Token: $ADMIN_API_TOKEN" -H "content-type: application/json" \
  -d '{"prompt":"海边日落，慢镜头推进","durationSec":5}'

# 图生视频（上传首帧）
curl -X POST http://127.0.0.1:8788/api/admin/video/generations \
  -H "X-Admin-Token: $ADMIN_API_TOKEN" \
  -F prompt="让画面动起来" -F image=@first-frame.png

# 轮询
curl http://127.0.0.1:8788/api/admin/video/generations/<taskId> -H "X-Admin-Token: $ADMIN_API_TOKEN"
```

任务对象：

```json
{
  "task": {
    "id": "vid_...",
    "mode": "text",
    "prompt": "海边日落，慢镜头推进",
    "status": "succeeded",
    "progress": 100,
    "provider": "openai-videos",
    "model": "sora-2",
    "params": { "durationSec": 5 },
    "sourceMedia": null,
    "media": { "id": "media_...", "kind": "file", "mime": "video/mp4", "bytes": 1234567, "url": "/api/media/media_..." },
    "error": null,
    "createdAt": "…", "updatedAt": "…", "startedAt": "…", "completedAt": "…"
  }
}
```

`status` 取值：`queued` → `running` → `succeeded` / `failed` / `cancelled`。失败原因写在 `error`。

创建请求的错误码：`400` 参数错误或参考图不合法；`404` `imageMediaId` 不存在；`429` 排队/生成中的任务已达上限（`maxActiveTasks`）；`503` 视频模型未配置。

`POST /api/admin/models/video/test` 固定返回 `400 test_unsupported`：视频生成计费且耗时数分钟，不作为连接探针；用 `discover` 拉取模型列表验证地址与密钥，再真发一次任务。

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

Admin 可管理聊天历史与搜索、Ombre / Memory 状态、表情包、媒体与图库、回收站 / 安全清理、审计日志。普通媒体导入使用 `POST /api/admin/media`，仅接受 Admin Token。

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
