# SOOYA 测试报告

生成时间：2026-07-28
环境：Linux x86_64 · Node.js v20.20.2 · npm 10.8.2 · 2 vCPU / 2 GB（与目标部署规格一致）
SQLite：3.53.2（better-sqlite3 12.11.1，WAL + FTS5）
浏览器：Chromium 151.0.7922.34（Playwright 1.62.0）

---

## 1. 总览

| 层次 | 用例数 | 结果 | 命令 |
| --- | ---: | --- | --- |
| 单元测试 | 35 | ✅ 全部通过 | `npm test` |
| 回归测试（审查缺陷）| 26 | ✅ 全部通过 | `npm test` |
| 集成 / API 测试（后端） | 108 | ✅ 全部通过 | `npm test` |
| 浏览器端到端（桌面 + 移动） | 38 | ✅ 全部通过 | `npm run test:e2e` |
| 部署验证（真实执行脚本） | 37 项断言 | ✅ 全部通过 | `./scripts/test-deploy.sh` |
| 发布包审计 | 18 项断言 | ✅ 全部通过 | `npm run verify:release` |
| 类型检查（前后端） | — | ✅ 无错误 | `npm run typecheck` |
| 依赖漏洞扫描 | — | ✅ 0 漏洞 | `npm audit` |
| **合计** | **262** | **✅** | |

后端测试 169 个（35 单元 + 26 回归 + 108 集成/API），浏览器 38 个，加上部署与打包断言共 262 项。

### 最近一次完整执行输出

```
$ npm run typecheck
（无输出 = 无类型错误）

$ npm test
 ✓ test/reliability.test.ts (21 tests)
 ✓ test/chat.test.ts        (34 tests)
 ✓ test/security.test.ts    (30 tests)
 ✓ test/regression.test.ts  (26 tests)
 ✓ test/memory.test.ts      (17 tests)
 ✓ test/stream.test.ts      ( 6 tests)
 ✓ test/unit.test.ts        (35 tests)
 Test Files  7 passed (7)
      Tests  169 passed (169)

$ npm run test:e2e
  38 passed (41.4s)          # desktop 19 + mobile 19

$ ./scripts/test-deploy.sh
[deploy-test] all deployment checks passed     # 37 项断言

$ npm run verify:release
[check-release] package audit passed           # 18 项断言

$ npm audit
found 0 vulnerabilities
```

---

## 2. 需求覆盖对照

需求文档第二十章列出的必测项，逐条对应到实际用例：

| 需求项 | 覆盖用例 | 层次 | 结果 |
| --- | --- | --- | --- |
| 发送文字 | `sends text and receives a streamed reply`、`stores the user message and a real assistant reply` | E2E + 集成 | ✅ |
| 流式回复 | `shows incremental streaming before the reply completes`、`streams text incrementally` | E2E + 集成 | ✅ |
| 表情包发送 | `SOOYA sends a sticker`、`sends a sticker when the model asks for one`、`sticker-only replies carry no text bubble` | E2E + 集成 | ✅ |
| 图片发送 | `SOOYA generates and displays an image`、`generates and stores a real image file` | E2E + 集成 | ✅ |
| 图片生成失败降级 | `image generation failure degrades without losing the text`、`explains itself when image generation is not configured` | E2E + 集成 | ✅ |
| TTS 发送 | `SOOYA sends a playable voice message with a real duration` | E2E | ✅ |
| TTS 失败降级 | `TTS failure falls back to a text bubble`、`voice-only keeps the text when TTS fails` | E2E + 集成 | ✅ |
| 多媒体组合消息 | `a combined reply renders text, sticker, image and audio together` | E2E + 集成 | ✅ |
| 消息刷新后恢复 | `messages survive a page reload` | E2E | ✅ |
| 历史分页 | `history loads older messages when scrolling up, without jumping`、`pages backwards through history without gaps or duplicates` | E2E + 集成 | ✅ |
| SSE 断线补偿 | `a reply produced while the tab is disconnected still appears without a manual refresh`、`replays missed events after a disconnect` | E2E + 集成 | ✅ |
| 重复消息幂等 | `a repeated clientMsgId never creates a second message or reply` + 5 路真并发验证 | 集成 | ✅ |
| 模型超时 | `surfaces a timeout as a visible message rather than losing the turn` | 集成 | ✅ |
| 数据库损坏恢复 | `detects corruption, quarantines the file and restores from a valid backup` 等 3 例 | 集成 | ✅ |
| 备份和恢复 | `creates a verified backup`、`restores data from a backup`、`detects a tampered backup`、部署脚本 restore | 集成 + 部署 | ✅ |
| 清空记忆 | `wipes memories, sources, summaries and the recall index` | 集成 | ✅ |
| Embedding 降级 | `falls back to FTS with an explicit reason`、`never reports 100% coverage with zero memories` | 集成 | ✅ |
| 上传限制 | `rejects a file larger than the configured limit`、`caps the number of files per request` | 集成 | ✅ |
| 路径穿越 | `rejects traversal in many encodings`（8 种攻击）、`does not serve files outside the media root` | 单元 + 集成 | ✅ |
| SSRF | `blocks dangerous protocols and private hosts`、`refuses to fetch a generated image from a private address` | 单元 + 集成 | ✅ |
| Token 鉴权 | `WEB_CHAT_TOKEN` 4 例 + `ADMIN_API_TOKEN` 3 例 | 集成 | ✅ |
| 部署健康检查 | `/health/live` `/health/ready` 在设置 token 后仍可探测 | 集成 + 部署 | ✅ |
| 升级保留运行配置 | 部署脚本实测：.env / persona / media / database / 聊天记录 | 部署 | ✅ |
| PWA 基础功能 | `PWA: manifest, icons and service worker are served correctly` | E2E | ✅ |
| 移动端页面 | 全部 19 个 E2E 用例在 Pixel 7 视口执行 | E2E | ✅ |
| 桌面端页面 | 全部 19 个 E2E 用例在 1280×860 执行 | E2E | ✅ |
| 发布包检查 | `npm run verify:release` 18 项 | 打包 | ✅ |

---

## 3. 各测试文件说明

### `test/unit.test.ts` — 35 例

指令解析（用户「发个表情 / 用语音说 / 不要发表情」与模型内联标记）、流式标记过滤器、
截断标记剥离、路径穿越（`..`、URL 单/双重编码、绝对路径、null 字节、符号链接逃逸）、
SSRF 地址分类、重试策略、密钥脱敏、音频时长解析（WAV/MP3 真实字节）、
图片尺寸解析、记忆归一化与向量序列化、原子写入与临时文件清理。

### `test/chat.test.ts` — 34 例

完整聊天链路：文字收发、无模型时的占位回复、幂等与并发序列化、表情包（模型触发 /
用户要求 / 禁止 / 只发表情 / 避免重复 / 「换一个」/ 无可用表情 / 文件丢失）、
图片（生成、失败降级、未配置）、语音（真实文件与时长、只发语音、失败回退、用户禁止）、
四种媒体组合、用户上传（单图 / 多图 / 普通文件 / 音频字段拒绝）、
历史分页、模型失败与超时。

### `test/memory.test.ts` — 17 例

记忆抽取与来源记录、琐碎内容不记、精确去重与语义合并、召回注入上下文、
过期与手动删除、Embedding 三种降级路径与诚实的覆盖率统计、
维度从配置读取（24/64 两组验证）、向量补写、彻底清空、
上下文压缩（分段摘要不重叠、原消息保留、摘要失败不影响聊天、上下文有界）。

### `test/stream.test.ts` — 6 例

在真实 TCP 端口上开 SSE 连接：完整事件生命周期（10 种事件）、增量文字、
断线后按 `Last-Event-ID` 补发、事件被裁剪时正确上报 `gapPossible`、
轮询兜底接口、**事件全部丢失时仍能通过 REST 读到数据库中的回复**。

### `test/reliability.test.ts` — 21 例

迁移幂等与表结构、外键级联、数据库损坏三种恢复路径、备份创建/校验/篡改检测/
恢复/保留策略、崩溃恢复（任务重入队、中断消息标记、重启后媒体可用）、
任务重试与失败、优雅关闭、媒体不入库为 Base64、孤儿媒体回收、失效媒体对账。

### `test/security.test.ts` — 30 例

两种令牌的鉴权矩阵、健康检查不受令牌影响、密钥不出现在任何响应中、
上传大小/数量/类型限制（含伪装成 PNG 的 ELF、SVG 脚本注入）、
路径穿越（含数据库被污染的情形）、SSRF（私网、`file://`）、
请求体上限、管理 API 全量覆盖、能力状态如实上报。

### `e2e/chat.e2e.ts` — 19 例 × 2 视口

在真实 Chromium 中对**真实构建产物 + 真实服务端**操作：界面不含任何多会话元素、
文字流式显示、表情/图片/语音渲染与播放（校验 `naturalWidth > 0`、
`audio.readyState >= 1`）、组合消息、刷新恢复、表情面板发送、图片上传、
向上分页、**翻看历史时不被强制拉到底部并出现未读提示**、
断网期间的回复自动补回（不刷新）、模型失败提示、PWA 资源、
Service Worker 缓存键不含令牌、响应式布局（无横向溢出、气泡不越界）。

---

## 4. 部署验证（真实执行）

`./scripts/test-deploy.sh` 在临时前缀下**真实运行** `install.sh` → `upgrade.sh` →
`rollback.sh` → `backup.sh` → `restore-backup.sh`，37 项断言全部通过：

- 安装：符号链接、前后端构建产物、`.env` 权限 600、自动生成管理令牌、服务健康
- 鉴权：设置 `WEB_CHAT_TOKEN` 后 `/health/live` 与 `/health/ready` 仍可无令牌探测，
  聊天 API 返回 401
- 升级：`.env` 校验和不变、自定义人格保留、用户媒体保留、数据库保留、
  自动生成升级前备份、聊天记录条数与内容不变
- 回滚：`current` 指向上一版本、服务健康、聊天记录与人格设置完好
- 备份/恢复：归档 + `.sha256` 校验通过、含数据库与媒体、**默认不含 `.env`**、
  恢复后备份时刻的数据回来了且备份之后的消息被正确回滚

> **限制说明**：容器内无 systemd，脚本中的 `systemctl` 由一个**真正启停进程**的
> shim 替代。构建、符号链接切换、健康探测、数据保留等逻辑走的都是生产代码路径；
> systemd 单元文件本身（加固选项、`SIGTERM` 语义）未在真实 systemd 上验证。

---

## 5. 发布包审计

`npm run verify:release` 解包两个归档并断言 18 项：

- SHA256 与 `SHA256SUMS.txt` 一致；ZIP 与 TAR.GZ 文件列表完全相同
- **不包含**：`node_modules`、真实 `.env`、`data/`、数据库文件、日志、
  用户媒体、备份、`dist/`、测试输出、`.git`、私钥、
  `config/models.json` 与 `config/persona.json`（避免升级覆盖用户配置）、QQ 登录数据
- 全文扫描无**真实**凭据（`AKIA*` / `ghp_*` / PEM 私钥）；`.env.example` 中所有密钥项为空。

  > **准确表述**：发布包中确实存在形如 `sk-…` 的字符串，全部是测试夹具里的
  > 假密钥，指向本地 Mock 服务，不对应任何真实账户：
  >
  > | 出现位置 | 假密钥 | 用途 |
  > | --- | --- | --- |
  > | `packages/server/test/helpers/harness.ts` | `sk-test-key-000000` | 集成测试的 Mock provider |
  > | `e2e/global-setup.ts` | `sk-e2e-mock-key` | 浏览器 E2E 的 Mock provider |
  > | `packages/server/test/regression.test.ts` | `sk-unit-test-key-000000`、`sk-env-supplied-secret-*`、`sk-file-original-key-*` 等 | 密钥落盘回归测试的夹具 |
  >
  > `scripts/check-release.mjs` 的密钥扫描据此把 `test/`、`e2e/` 目录下的
  > 夹具值列入白名单，同时对其余所有文件保持严格匹配——即真实源码、配置和
  > 文档中出现任何 `sk-` 开头的长串仍会导致打包审计失败。
- **包含**：源码、测试、e2e、部署脚本、systemd 单元、Nginx 示例、Dockerfile、
  文档、内置表情包（11 个）
- 部署脚本在两种归档中都保留了可执行位

实际产物：

```
sooya-1.0.0.zip     355.8 KB
sooya-1.0.0.tar.gz  289.3 KB
SHA256SUMS.txt
```

---

## 6. 测试中发现并修复的真实缺陷

以下缺陷均由测试或审查**首次发现**，已修复并补充回归测试。

| # | 缺陷 | 影响 | 发现方式 | 修复 |
| --- | --- | --- | --- | --- |
| 1 | `await reply.code(...)` —— Fastify 的 reply 是 thenable，await 会永久挂起 | 所有错误响应路径超时 | 集成测试超时 | 改为 `return reply.code(...)`，preHandler 返回 reply |
| 2 | `safeJoin` 未拒绝绝对路径 | 路径穿越风险 | 单元测试 | 显式拒绝绝对路径与盘符路径 |
| 3 | 中文分词：`normalizeMemoryText` 未去除 CJK 间空格 | 「喜欢 猫」与「喜欢猫」被存成两条记忆 | 单元测试 | CJK 间空白归一 |
| 4 | FTS5 `unicode61` 把整句中文当一个 token | 中文记忆几乎永远召回不到 | 集成测试 | 迁移 3 改用 `trigram` + 三层检索（trigram → bigram 重叠 → 空） |
| 5 | `EventRepo.lastSeq()` 用 `MAX(seq)`，裁剪后回退 | 重连客户端漏事件 | 集成测试 | 改用单调计数器，新增 `oldestSeq()` 与准确的 `gapPossible` |
| 6 | 恢复备份时未关闭活动连接 | WAL 回放把被回滚的数据写回，恢复实际无效 | 集成测试 | 恢复前关闭连接、恢复后重开；引入 `DbHandle` 间接层 |
| 7 | `error_log` 原样存储 provider 报错文本 | 管理接口可能回显 API Key | 安全测试 | 写入前脱敏 |
| 8 | SPA 兜底对缺失的 `/assets/*.js` 返回 HTML | 浏览器严格 MIME 校验失败，白屏 | 浏览器验证 | 仅对导航请求返回 shell |
| 9 | 首屏未定位到最新消息；异步加载的图片撑高后视图漂移 | 打开就停在历史中间 | 浏览器验证 | 首帧强制置底 + `ResizeObserver` 跟随 |
| 10 | 加载历史与新消息同一帧到达时未读计数被吞 | 看历史时收不到新消息提示 | 浏览器验证 | 未读改为按「末条消息 id 之后新增数」独立计算 |
| 11 | 「换一个表情」在 `avoidRepeatWindow=0` 且提示只匹配一个表情时返回同一张 | 用户明确要求换却没换 | 审查 Round 1 | 强制排除上一张，必要时放宽提示重选 |
| 12 | 上传后未发送的媒体永久残留 | 磁盘缓慢泄漏 | 审查 Round 1 | 维护任务回收孤儿上传（保护 2 小时内的草稿与被引用媒体） |
| 13 | 流在标记中途断开时残留 `[[sticker:开` | 用户看到内部标记 | 审查 Round 2 | 剥离结尾的截断标记，且不误伤 `arr[[0]]` 等合法文本 |
| 14 | Service Worker 用带 token 的 URL 作缓存键 | 密钥写入 Cache Storage，换令牌后缓存全失效 | 审查 Round 2 | 用裸路径作键，并跳过 206 响应 |

另有 2 处为审查中的**误报**，经反证排除（详见 `docs/REVIEW.md`）。

### 6.1 外部审查提出的 6 个缺陷（本轮修复）

以下缺陷来自外部审查报告，每一项都先补了**修复前必然失败**的回归测试
（`packages/server/test/regression.test.ts`，共 26 例），再动实现。

| # | 缺陷 | 根因 | 修复 | 回归测试 |
| --- | --- | --- | --- | --- |
| 1 | 环境变量 API Key 被写入 `models.json` 并进入备份 | `setModels()` 以**已注入 env 密钥**的运行时配置为 merge base，整体回写磁盘 | 新增 `fileModels` 保存磁盘原值；写盘以它为基准，并用 `stripEnvInjectedKeys()` 剔除仅来自 env 的密钥（显式传入的 key 仍保留） | `defect 1` × 4 |
| 2 | Docker Compose 首次启动 data/config 属主错误 | compose 未声明 `user:`，Docker 以 root 创建挂载源，镜像内 uid 1001 无法写入 | compose 增加 `user: "${SOOYA_UID:-1001}:${SOOYA_GID:-1001}"`；新增 `deploy/docker-entrypoint.sh` 预检可写性并打印修复指引；`.env.example` 补 `SOOYA_UID/GID` | `defect 2` × 3 |
| 3 | 恢复旧库后客户端状态与消息/事件序号不一致 | 恢复把 counters 一并回退，仍连接的客户端 `Last-Event-ID` 永久领先服务端，此后收不到任何事件 | 新增 `raiseCounter()` / `reconcileCounters()`；恢复前记录水位、恢复后抬升；`system.notice` 携带 `action:"reload"`，前端 `reload()` 丢弃本地状态重取；启动时也做一次对账 | `defect 3` × 3 |
| 4 | 首屏消息快照与 SSE 起点存在竞态 | 快照来自 `/api/messages`，游标来自另一次 `/api/conversation`，两次请求之间产生的事件既不在快照里也不会被补发 | `/api/messages` 在读取行**之前**取事件游标并随响应返回；前端改用 `page.lastEventSeq` 播种 SSE | `defect 4` × 3 |
| 5 | SQLite 备份的备用复制流程无 WAL 一致性 | 逐个 `cp` 主库与 `-wal`/`-shm`，其间发生 checkpoint 会得到互相矛盾的文件对 | 备用路径改为 `sqlite3 .backup` →（失败则）`VACUUM INTO` →（无 CLI 则）better-sqlite3 backup API →（最后兜底）先 `wal_checkpoint(TRUNCATE)` 再复制；归档前跑 `integrity_check` | `defect 5` × 3 |
| 6 | 流式聊天请求的 `maxRetries` 不生效 | `complete()` 包了 `withRetry`，`stream()` 没有 | 新增 `streamWithRetry()`：三个 provider 的 `stream()` 统一走重试，且**仅在尚未吐出任何 token 时**才重试，避免重复文本 | `defect 6` × 4 |
| 7 | （连带发现）流中断会丢弃已收到的文本 | `readSse` 在 `reader.read()` 抛错时直接冒泡，缓冲区里已解析出的 `data:` 行未派发 | 抽出 `drainLines()`，出错时先冲刷已收到的内容再抛出 | 由 `defect 6` 的中断用例覆盖 |

#### 验证过程中另外发现并修复的 2 个缺陷

| # | 缺陷 | 发现方式 | 修复 | 回归测试 |
| --- | --- | --- | --- | --- |
| 8 | `npm run test:e2e` 完全无法启动 | 执行第 5 步验证序列时，`npx playwright test` 可用但 `npm run test:e2e` 报 `MODULE_NOT_FOUND` / `exports is not defined` | 根目录 `playwright.config.ts` 是转发器，Playwright 按**它**的位置解析相对路径，`./global-setup.ts` 落到了仓库根。改为在 `e2e/playwright.config.ts` 里用 `__dirname` 锚定 `testDir` 与两个 global 钩子（不用 `import.meta`，因为根目录无 `"type":"module"`，配置可能走 CJS 转换） | `defect 7` × 3 |
| 9 | 发布包中部署脚本丢失可执行位 | `npm run verify:release` 报 `deployment scripts are executable` 失败 | 就地重写文件的工具会清掉 x 位。`scripts/make-release.mjs` 现在在打包阶段对 7 个脚本强制 `chmod 755`，杜绝再次发生 | 由 `verify:release` 的 18 项断言覆盖 |

修复涉及的文件：`config/store.ts`、`db/index.ts`、`backup/service.ts`、`app.ts`、
`routes/admin.ts`、`routes/chat.ts`、`providers/chat/openai.ts`、
`web/src/lib/useChat.ts`、`web/src/lib/api.ts`、`docker-compose.yml`、
`Dockerfile`、`deploy/docker-entrypoint.sh`、`deploy/backup.sh`、`.env.example`、
`e2e/playwright.config.ts`、`playwright.config.ts`、`scripts/make-release.mjs`、
`scripts/check-release.mjs`。

---

## 7. 未经真实第三方 API 验证的部分

以下内容**仅用本地 OpenAI 兼容 Mock 服务验证**（真实 HTTP、真实 SSE、真实 PNG/MP3 字节），
未使用任何厂商的真实密钥。上线前需用真实凭据复验：

- OpenAI Chat Completions / Responses / Anthropic Messages 三种协议的真实报文兼容性
- 真实 TTS 音色、时长与音频格式
- 真实图片生成模型的返回形态（`b64_json` 与 `url` 两条路径都已实现，仅 Mock 验证）
- 真实 Embedding 维度与召回质量
- 用户语音输入未纳入当前产品范围；音频字段拒绝路径已由集成测试覆盖
- 第三方限流（429）与真实网络抖动下的重试表现

同样未在真实环境验证的还有：systemd 单元的加固选项、Nginx + TLS 实际转发、
长期（数周以上）运行的内存与磁盘表现。
