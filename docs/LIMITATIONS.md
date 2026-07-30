# SOOYA 已知限制

本文件如实列出当前版本的边界。凡是**没有用真实第三方 API 验证过**的内容，
都在这里写清楚，不会在别处被说成「已完全验证」。

---

## 1. 未经真实第三方 API 验证

所有模型能力都通过一个**本地 OpenAI 兼容 Mock 服务**验证：它是真实的 HTTP 服务器，
输出真实的 SSE 流、真实的 PNG 字节、结构合法的 MP3 帧。因此 SOOYA 这一侧的
请求构造、流解析、落盘、时长探测、降级路径都是真实跑通的。

**但没有用任何厂商的真实密钥调用过真实 API。** 以下需要你在部署后自行复验：

| 项目 | 已验证 | 待真实验证 |
| --- | --- | --- |
| OpenAI Chat Completions | 请求体、SSE 增量解析、超时、重试 | 真实模型的报文细节与限流行为 |
| OpenAI Responses 风格 | 适配器代码路径、`output_text` 与 `response.output_text.delta` 解析 | **未与真实端点对接过** |
| Anthropic Messages | 适配器代码路径、`content_block_delta` 解析、`x-api-key` 头 | **未与真实端点对接过** |
| OpenAI 兼容第三方 | 与 Chat Completions 同一实现 | 各家实现差异（尤其流式帧格式） |
| TTS | 音频落盘、时长探测、失败回退 | 真实音色、真实时长、非 mp3 格式 |
| 图片生成 | `b64_json` 与 `url` 两条路径、失败降级 | 真实模型返回形态、生成耗时 |
| Embedding | 维度校验、召回、三级降级 | 真实向量的召回质量 |
| STT | 上传转写链路、失败处理 | 真实转写准确度 |

**建议的上线自检：**

```bash
curl -s http://127.0.0.1:8788/api/capabilities | jq .capabilities
# 然后在界面里依次要求：发个表情 / 生成一张图片 / 用语音说一句 / 发张图给它看
```

> `/api/capabilities` 里的 `configured: true` 只表示**配置齐全**，
> `ok: true` 只表示**配置齐全且端点地址通过 SSRF 校验**。
> 两者都**不代表**已经成功调用过第三方 API。

---

## 2. 未在真实环境验证的部署要素

| 项目 | 情况 |
| --- | --- |
| systemd 单元 | 单元文件已编写并包含加固选项；容器内无 systemd，验证时用一个**真正启停进程**的 shim 替代。构建、符号链接切换、健康探测、数据保留走的都是生产代码路径，但 `ProtectSystem=strict` 等加固项、`SIGTERM` 的真实语义**未在真实 systemd 上验证** |
| Nginx + TLS | 提供了配置示例（SSE 关缓冲、上传大小、健康检查限本机、CSP）；**未在真实 Nginx 上跑过** |
| Docker 镜像 | Dockerfile 与 compose 已编写；**本环境未执行过 `docker build`**（沙箱无 Docker 守护进程） |
| 长期运行 | 最长连续运行为分钟级。数周以上的内存增长、磁盘增长、WAL 体积**未观测** |
| 真实 2C2G 机器 | 开发与测试环境为 2 vCPU / 2 GB（与目标规格一致），但非真实 VPS，无真实网络抖动 |

---

## 3. 功能边界（有意为之）

- **不实现 Agent。** `packages/server/src/agent/` 只有 `CapabilityRegistry`、
  `ToolRegistry`、`AgentWorker` 接口，没有任何实现，聊天模块不 import 它。
  `/api/admin/system` 会如实返回 `agent.active: false`、`tools: []`。
- **管理控制台已有网页。**（本条原文为「不做管理面板网页」，已过期。）
  `packages/web/src/components/AdminPanel.tsx` 是一个九标签页控制台：概览、
  助手配置、模型配置、双方头像、情绪语音、世界引擎、内容管理、存储治理、
  运维与备份。它调用的仍然只是 `/api/admin/*`——那 29 个路由**读写都挂了
  同一个守卫**，未配置 `ADMIN_API_TOKEN` 时一律 503，token 不对则 401
  （请求头是 `x-admin-token`，不接受 `Bearer`）。所以页面本身
  **不构成一层新的权限**，没有 token 时它连数据都读不到。
- **单人格，无切换。** 人格在 `config/persona.json`，UI 与数据库都不提供切换。
- **单会话，硬编码 `conversation_id = "main"`。** 无新建/删除/切换聊天。
- **无用户系统。** 没有注册、多账号、工作区。

---

## 4. 已知技术限制

### 4.1 依赖版本锁定

- **`better-sqlite3` 锁定 `^12.x`。** 13.0.1/13.x 在本项目环境中 `new Database()`
  即触发 SIGSEGV（预编译二进制与源码编译均复现）。12.11.1 在同环境下
  WAL、FTS5、在线备份全部正常。升级前请先在目标机器上验证。
- **PWA 未使用 `vite-plugin-pwa`。** 其依赖链带一个 high 级别漏洞告警
  （`workbox-build → ejs → jake → filelist → minimatch → brace-expansion`）。
  改为手写约 90 行的 `public/sw.js`，`npm audit` 因此为 0 漏洞。
  代价：没有 Workbox 的预缓存清单自动生成，SW 里的静态资源列表需要手工维护
  （目前只精确列出应用外壳，其余走 stale-while-revalidate，因此实际影响很小）。

### 4.2 记忆与检索

- Embedding 相似度是**全表扫描 + 余弦距离**，没有向量索引（无 sqlite-vec 等扩展）。
  单用户场景下几千条记忆完全够用；**记忆量到万级以上会明显变慢**。
- Embedding 不可用时的 bigram 重叠检索同样是全表扫描（上限 2000 条）。
- 记忆抽取依赖模型返回合法 JSON。模型不配合时退回一组高精度正则（姓名、城市、
  职业、喜好、项目），**召回率低但不会误记**。
- 中文 FTS 用 `trigram` 分词器，**2 个字以内的查询词无法命中 FTS**，会退到 bigram 重叠。

### 4.3 多媒体

- 多媒体靠**内联标记**（`[[sticker:开心]]` 等）而非 tool calling，好处是任何
  OpenAI 兼容模型都能用，代价是**依赖模型遵守指令**。模型不输出标记时，
  只有用户显式要求才会触发媒体。
- 图片理解需要模型在 `models.json` 中声明 `supportsVision: true`，
  且单张图片超过 4 MB 时会退化成 `[图片]` 文本占位。
- 音频时长解析是自实现的容器解析（WAV/MP3/OGG/WebM/MP4/FLAC），无 ffmpeg 依赖。
  遇到不认识的容器会返回 `null` 并退回客户端上报的时长；**绝不编造时长**。
- 图片尺寸解析支持 PNG/JPEG/GIF/WebP，其余格式 `width/height` 为 `null`。
- 一次回复最多一张生成图片（`imagePolicy.maxPerReply` 上限为 4，但当前编排逻辑
  只处理模型给出的第一个 `[[image:]]` 标记）。

### 4.4 并发与规模

- 设计前提是**单用户**。`/api/messages` 用串行锁保证回复顺序，多个客户端同时
  发消息会排队而不是并行。
- SQLite 单写者。备份走在线备份 API，不阻塞聊天，但大库备份期间 IO 会升高。
- SSE 事件日志保留最近 2000 条。客户端离线时间过长导致事件被裁剪时，
  服务端会返回 `gapPossible: true`，前端改用 REST 对账——**不会丢消息，
  但会丢失中间过程事件**（例如逐字增量）。

### 4.5 前端

- 语音录制依赖 `MediaRecorder` + `getUserMedia`，需要 **HTTPS 或 localhost**。
  http:// 的局域网地址下浏览器会拒绝麦克风权限。
- iOS Safari 对 PWA 的支持有限（无推送、后台会被回收）；页面切回前台时会自动对账。
- 录音格式由浏览器决定（通常 webm/opus，Safari 为 mp4）。服务端接受这些格式，
  但**转写质量取决于 STT 服务对该格式的支持**。
- 未做虚拟滚动。历史消息很多时靠分页（每页 30 条）控制 DOM 规模；
  一次性向上翻很多页后，DOM 节点数会线性增长。
- 未实现 i18n，界面文案为中文。

### 4.6 安全

- 单用户系统，令牌是**共享密钥**，没有会话、没有刷新、没有吊销列表。
  令牌泄露的唯一处置是更换 `WEB_CHAT_TOKEN` 并重启。
- 令牌保存在 `localStorage`；媒体请求通过查询参数携带令牌（`<img>`/`<audio>`
  无法自定义请求头）。这意味着**令牌会出现在服务端访问日志的 URL 中**——
  应用自身的日志已脱敏，但**反向代理的 access log 需要你自行处理**。
- 没有 CSRF token。API 全部要求自定义头或显式令牌，且默认 `SameSite` 行为下
  跨站请求无法携带 localStorage 中的令牌，但 CORS 目前配置为 `origin: true`
  （单用户本地部署的便利取舍）；**公网部署建议在 Nginx 层限制来源**。
- 没有速率限制。单用户场景下由令牌保护；若担心令牌泄露后被刷，
  请在 Nginx 层加 `limit_req`。
- 上传文件不做病毒扫描，只做类型白名单 + 内容嗅探 + 大小限制。

### 4.7 数据

- 媒体文件**不参与数据库备份的原子性**。`deploy/backup.sh` 会把 `media/` 一起打包，
  但数据库快照与媒体快照之间存在**秒级窗口**：极端情况下备份里可能有一条引用了
  尚未拷贝完的媒体的消息。恢复后表现为该媒体 404，不影响其他内容。
- 清空聊天（`/api/admin/chat/clear`）**不删除媒体文件**，媒体由孤儿回收任务
  在 2 小时后处理（仅限 `origin=upload` 且无引用者）。生成类媒体在消息被删除后
  会成为无引用文件，需要手动通过 `/api/admin/media/:id` 清理。
- 没有导出/导入聊天记录的接口。需要迁移时直接复制 `data/` 目录。

---

## 5. 明确不做的事

- 不引入 Kubernetes、微服务、Redis、消息队列、Elasticsearch、需要登录的云平台。
- 不使用任何厂商的商标、图标或美术素材。内置表情包与图标全部由
  `scripts/gen-stickers.mjs`、`scripts/gen-icons.mjs` 以代码绘制生成。
- 不内置任何 QQ 相关的登录、协议或数据。

---

## 6. 建议的后续工作

按优先级：

1. 用真实密钥完成第 1 节的能力自检，特别是 Responses 与 Anthropic 两条适配器路径。
2. 在真实 systemd + Nginx 环境跑一遍 `install.sh` → `upgrade.sh` → `rollback.sh`。
3. 反向代理层：为 `/api/media/` 关闭 access log 中的 query string，避免记录令牌。
4. 记忆量增长后引入向量索引（sqlite-vec 或定期归档低价值记忆）。
5. 历史消息很多时加入虚拟滚动。
6. 媒体与数据库的一致性快照（先冻结写入再同时快照）。
