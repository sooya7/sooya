# SOOYA

> 单用户 · 单人格 · 单条永久连续聊天 · 独立运行的私人 AI 聊天机器人

SOOYA 不是 ChatGPT 式的多会话平台，也不是多人聊天系统。打开网页就直接进入**唯一的一条聊天**，
这条聊天永远存在、永远连续。SOOYA 会记得你们聊过什么，并且会自己决定该用文字、表情包、图片
还是语音来回答你。

```
你：    在吗
SOOYA： 我在呢。 [表情包]
你：    用语音说晚安
SOOYA： 晚安，好好睡一觉。 [语音 0:04 ▶]
```

---

## 目录

- [核心特性](#核心特性)
- [快速开始](#快速开始)
- [配置模型](#配置模型)
- [让 SOOYA 发表情、图片和语音](#让-sooya-发表情图片和语音)
- [项目结构](#项目结构)
- [常用命令](#常用命令)
- [文档](#文档)
- [技术栈与取舍](#技术栈与取舍)
- [许可](#许可)

---

## 核心特性

**真正的多媒体回复。** SOOYA 自己会发送：纯文字、纯表情包、纯图片、纯语音，以及
「文字 + 表情包 + 图片 + 语音」的任意组合。用哪种由模型根据聊天内容自主决定，你也可以直接
要求「发个表情」「用语音说」「生成一张图片」「只发语音」「不要发表情」。

**媒体是真实文件。** 语音是服务端 TTS 生成并落盘的音频文件，刷新页面、重启服务器之后仍然
可以播放、拖动进度、变速；不是浏览器 `speechSynthesis` 的临时朗读。表情包是本地图库
（PNG / GIF，随项目附带一套可用的测试表情），不依赖任何外部图片 URL。

**不会「回复写进数据库但页面看不到」。** 每个事件在推送前先持久化并带上单调递增的序号；
SSE 断线重连时按 `Last-Event-ID` 补发遗漏事件，补不上时前端会自动改用 REST 从数据库对账。

**降级而不是崩溃。** 图片生成失败 → 保留文字并说明原因；TTS 失败 → 自动回退成文字气泡；
Embedding 不可用 → 回退到全文检索并明确记录原因（0 条记忆绝不会显示成 100% 覆盖率）；
任何一个能力没配置，机器人依然正常启动。

**可靠性。** 数据库损坏自动检测、隔离并从最近的有效备份恢复；配置与媒体原子写入；
进程异常退出后未完成任务自动恢复；重复请求幂等；定时 + 手动备份，备份带校验和恢复验证。

**前端。** 简洁浅色界面、左右气泡、双方头像、表情/图片/文件/语音录制、移动端与桌面端适配、
PWA 可安装到手机桌面、向上加载历史、断线重连补偿，**你在翻旧消息时不会被强制拉到底部**。

---

## 快速开始

### 环境要求

- Node.js **20.10+**（推荐 20 LTS）
- Linux / macOS，2 核 2 GB 即可稳定运行
- 编译 `better-sqlite3` 需要 `python3` / `make` / `g++`

### 本地运行

```bash
git clone <your-repo> sooya && cd sooya

npm ci                        # 安装依赖（会编译 better-sqlite3）
cp .env.example .env          # 配置
chmod 600 .env

npm run build                 # 构建后端 + 前端
npm start                     # http://127.0.0.1:8788
```

打开 <http://127.0.0.1:8788> 就是聊天界面。

> **没有配置任何模型也能启动。** SOOYA 会正常运行，并在回复里明确告诉你还没配置聊天模型，
> `GET /api/capabilities` 会如实列出每项能力的可用状态。

### 开发模式

```bash
npm run dev -w @sooya/server   # 后端，tsx watch，8788
npm run dev -w @sooya/web      # 前端，Vite，5173（自动代理 /api 到 8788）
```

### Docker

```bash
cp .env.example .env && chmod 600 .env
docker compose up -d --build
curl http://127.0.0.1:8788/health/ready
```

数据挂在 `./data`，配置挂在 `./config`，重建镜像不会丢。

### 生产部署（Linux 原生）

```bash
sudo ./deploy/install.sh          # 安装到 /opt/sooya 并注册 systemd
sudo systemctl restart sooya
sudo systemctl restart sooya
```

完整说明（Nginx、TLS、升级、回滚、备份）见 **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**。

---

## 配置模型与联网搜索

打开 `/admin/models`（管理后台 → 模型配置）即可管理聊天、视觉、总结、Embedding、图片、语音、Rerank 和联网搜索。API Key 只提交给服务端，读取页面时仅返回“已配置”状态，不会回传明文。

联网搜索就在同一能力列表中，可自由选择并排序豆包、Tavily、Responses；只选择一个提供方时不会隐式回退。豆包支持 `custom` / `global` 切换，每个提供方都可在保存后直接测试连接。Responses 复用聊天模型，要求聊天协议为 `openai-responses` 且启用工具能力。

页面配置保存在 `config/models.json`。运维也可以直接编辑服务器上的这同一份文件，完整校验通过后会自动热加载；无效编辑不会覆盖上一次有效配置。旧版模型/搜索环境变量只在首次升级迁移时读取，迁移后不再覆盖页面或文件。

`models.json` 支持 `openai-chat` / `openai-responses` / `anthropic-messages` / `openai-compatible` 等协议，例如：

```jsonc
{
  "chat": {
    "provider": "openai-chat",
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "",              // 也可直接在管理页面安全保存
    "model": "gpt-4o-mini",
    "timeoutMs": 60000,
    "maxTokens": 1024,
    "temperature": 0.8,
    "contextWindow": 128000,
    "supportsVision": true,    // 打开后 SOOYA 才能看懂你发的图片
    "supportsTools": false,
    "supportsStreaming": true,
    "maxRetries": 2
  },
  "vision":  { "...": "可选，不填就复用 chat" },
  "summary": { "...": "可选，可以指向更便宜的小模型" },
  "embedding": { "provider": "openai-embeddings", "model": "text-embedding-3-small", "dimensions": 1536 },
  "image":     { "provider": "openai-images",     "model": "gpt-image-1" },
  "tts":       { "provider": "openai-tts",        "model": "gpt-4o-mini-tts", "voice": "alloy", "format": "mp3" }
}
```

Embedding 维度从配置（或首次响应）读取，**不写死**；配置的维度和实际返回不一致会直接报错，
而不是悄悄存入脏向量。

### 配置人格

`config/persona.json`，首次启动生成。人格不写死在前端，第一版只有一个人格，
UI 和数据库都不提供人格切换。

```jsonc
{
  "name": "SOOYA",
  "systemPrompt": "你是 SOOYA，用户唯一的私人 AI 伙伴……",
  "speakingStyle": "口语化中文，句子短，偶尔用语气词……",
  "relationshipContext": "你和用户是长期相处的朋友……",
  "stickerPolicy": { "enabled": true, "frequency": "medium", "maxPerReply": 1, "avoidRepeatWindow": 5 },
  "voicePolicy":   { "enabled": true, "frequency": "low", "maxCharsPerClip": 300 },
  "imagePolicy":   { "enabled": true, "frequency": "low", "maxPerReply": 1 }
}
```

---

## 让 SOOYA 发表情、图片和语音

SOOYA 通过在回复末尾输出**内联标记**来触发多媒体，标记会被剥离，用户永远看不到：

| 标记 | 效果 |
| --- | --- |
| `[[sticker:开心]]` | 发一个「开心」情绪的表情包 |
| `[[sticker-only:难过]]` | 这一条只发表情包，不发文字 |
| `[[image:一只趴在窗台上的猫]]` | 生成并发送一张图片 |
| `[[voice]]` | 这条文字同时用语音发出来 |
| `[[voice-only]]` | 只发语音（文字保留为语音文稿） |

这些标记由系统提示词自动注入，**不需要模型支持 tool calling**，所以任何 OpenAI 兼容的模型
都能用。用户的显式要求（「不要发表情」）优先级最高，会覆盖模型的决定。

表情包会避免连续重复；语境里找不到合适的表情时**宁可不发**，不会硬凑一个不相关的。

---

## 项目结构

```
sooya/
├── packages/
│   ├── server/                  Fastify + SQLite 后端
│   │   ├── src/
│   │   │   ├── config/          环境变量、persona/models 配置存储
│   │   │   ├── db/              迁移、连接句柄、各 repository
│   │   │   ├── core/            能力注册表、上下文、记忆、摘要、回复编排
│   │   │   ├── providers/       chat / embedding / image / tts 适配器
│   │   │   ├── media/           媒体落盘、表情包库
│   │   │   ├── events/          持久化事件总线（SSE 补偿的基础）
│   │   │   ├── routes/          chat / media / stream / admin / health
│   │   │   ├── backup/          备份、校验、恢复
│   │   │   └── agent/           Agent 架构预留（v1 不实现任何 Agent）
│   │   └── test/                单元 + 集成 + API 测试（138 个）
│   └── web/                     React + Vite + PWA 前端
├── e2e/                         Playwright 浏览器端到端测试（36 个）
├── assets/stickers/             内置表情包（脚本生成，无第三方素材）
├── deploy/                      install / upgrade / rollback / backup / systemd / nginx
├── scripts/                     打包、发布包检查、部署验证、素材生成
└── docs/                        部署 / API / 数据库 / 测试报告 / 审查 / 已知限制
```

---

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm run build` | 构建后端和前端 |
| `npm start` | 启动生产服务 |
| `npm test` | 后端单元 + 集成 + API 测试 |
| `npm run test:e2e` | Playwright 浏览器端到端测试（需先 build） |
| `npm run typecheck` | 前后端 TypeScript 类型检查 |
| `npm run package` | 生成发布包（ZIP + TAR.GZ + SHA256） |
| `npm run verify:release` | 审计发布包（不含密钥/数据/依赖） |
| `./scripts/test-deploy.sh` | 真实跑一遍 安装 → 升级 → 回滚 → 备份 → 恢复 |
| `node scripts/gen-stickers.mjs` | 重新生成内置表情包 |

---

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | 部署、Nginx、TLS、升级回滚、备份恢复、故障排查 |
| [docs/API.md](docs/API.md) | 全部 HTTP 接口、SSE 事件、消息数据结构 |
| [docs/DATABASE.md](docs/DATABASE.md) | 数据库表结构、索引、迁移机制 |
| [docs/TEST-REPORT.md](docs/TEST-REPORT.md) | 测试范围与实际执行结果 |
| [docs/REVIEW.md](docs/REVIEW.md) | 三轮互审记录与裁决 |
| [docs/LIMITATIONS.md](docs/LIMITATIONS.md) | 已知限制与尚未真实验证的部分 |

---

## 技术栈与取舍

**后端** Node.js 20 · TypeScript · Fastify 5 · SQLite (better-sqlite3, WAL) · Zod · Pino
**前端** React 19 · TypeScript · Vite 6 · 原生 CSS · 手写 Service Worker
**测试** Vitest · Fastify inject · Playwright

刻意**没有**引入：Kubernetes、微服务、Redis、消息队列、Elasticsearch、需要登录的云平台。
目标就是在一台 2 核 2 GB 的 Linux 机器上，用一个进程稳定跑下去。

两处与默认技术栈的偏离，理由如下：

1. **`better-sqlite3` 锁定 `^12.x`**。13.x 在本项目的构建/运行环境中加载后即段错误
   （`new Database()` 直接 SIGSEGV）。12.11.1 在同环境下 WAL、FTS5、在线备份全部正常。
2. **PWA 不用 `vite-plugin-pwa`（Workbox）**，改为手写 `public/sw.js`。该插件的依赖链
   （`workbox-build → ejs → jake → filelist → minimatch → brace-expansion`）带有一个 high
   级别漏洞告警；SOOYA 只需要「应用外壳离线 + 媒体缓存 + 不缓存 API」这点逻辑，手写约 90 行，
   `npm audit` 因此为 0 漏洞。

---

## 许可

MIT，见 [LICENSE](LICENSE)。

内置表情包与图标均由 `scripts/gen-stickers.mjs`、`scripts/gen-icons.mjs` 以代码绘制生成，
不含任何第三方商标或素材。界面参考现代即时通讯软件的通用交互范式，未使用任何厂商的商标、
图标或美术资源。
