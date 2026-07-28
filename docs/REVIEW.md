# SOOYA 三轮互审报告

审查方式按要求执行：

- **审查方 A** — 主动找问题，不预设代码是对的，优先攻击边界与失败路径。
- **实现方 B** — 对每条指控寻找反证，避免误报被当成缺陷。
- **复核方 C** — 检查双方证据，做最终裁决。

规则：任意一轮发现**真实问题**即立刻修复、重跑全部测试、**审查计数归零重新开始**。
只有连续三轮全面审查均未发现新的真实问题，才允许交付。

本文件记录的是**归零之后**的连续三轮。在此之前的轮次共发现 4 个真实缺陷
（编号 R0-1 ~ R0-4），修复后计数已重置；这些缺陷同样记录在下方与
`docs/TEST-REPORT.md` 第 6 节。

---

## 归零前：R0 轮（发现真实问题 → 计数重置）

| 编号 | A 的指控 | B 的反证 | C 的裁决 | 处置 |
| --- | --- | --- | --- | --- |
| R0-1 | 「换一个表情」可能返回同一张 | 默认 `avoidRepeatWindow=5` 已排除近期表情 | **A 成立**：把 `avoidRepeatWindow` 配成 0 且提示只命中一张时（`[[sticker:晚安]]`），实测两次返回同一 `stickerId` | 修复：用户要求更换时强制排除上一张，命中不足则放宽提示重选；补回归测试 |
| R0-2 | 上传后未发送的媒体永久残留 | 前端会在发送后清空附件区 | **A 成立**：用户放弃草稿时文件与 DB 行都留下，实测 `orphan media on disk: true / referenced by parts: 0` | 修复：维护任务回收 origin=upload 且无引用、超过 2 小时的媒体；补 2 个测试（保护新草稿与被引用媒体） |
| R0-3 | 流在标记中途断开会残留 `[[sticker:开` | 流式过滤器 `StreamingDirectiveFilter` 已缓冲半个标记 | **A 成立**：过滤器只影响推送，最终 `stripModelDirectives` 只匹配完整标记，实测入库文本为 `"你好呀[[sticker:开"` | 修复：额外剥离结尾截断标记；同时验证 `arr[[0]]`、`[[note]]` 等合法文本不被误删 |
| R0-4 | Service Worker 把带 token 的 URL 当缓存键 | 令牌本来就在同源 localStorage 里 | **A 成立**：Cache Storage 的 key 会持久化密钥，且轮换令牌后全部缓存失效；属真实（低危）缺陷 | 修复：用裸路径作键、跳过 206；补 E2E 断言「任何缓存键不含 `token=`」 |

修复后重跑：类型检查通过、后端 143 例通过、E2E 38 例通过、部署 37 项通过。**计数归零。**

---

## 第 1 轮

### A 的指控

| 编号 | 指控 |
| --- | --- |
| A1-1 | 恢复备份后 `DbHandle` 换了连接，先前 repository 持有的 statement 会指向已关闭的连接而崩溃 |
| A1-2 | 反复连接/断开 SSE 会泄漏 EventEmitter listener |
| A1-3 | `events` / `error_log` / `jobs` 三张表会无限膨胀，长期运行撑爆小机器磁盘 |
| A1-4 | 助手回复「只有表情包」时，下一轮上下文会产生空 content，被 OpenAI 拒绝 |
| A1-5 | 媒体目录不可写时 TTS 会抛异常，整条回复丢失 |

### B 的反证

| 编号 | 反证与证据 |
| --- | --- |
| A1-1 | `DbHandle` 的 `prepare/exec/pragma/transaction` 都是**调用时**解析 `this.current`，不缓存 statement。实测：恢复后立即用同一批 repo 继续发消息 → `post-restore reply: 三`，`media repo works: true`，`stickers: 11` |
| A1-2 | `req.raw.on('close')` 与 `reply.raw.on('error')` 都会调用 `cleanup()` 注销订阅。实测 12 次连接/断开后 `subscriberCount: 0` |
| A1-3 | 三张表都有上限：`events` 由维护任务 `prune(2000)` 裁剪（实测 prune 后仅剩 10 条且 `lastSeq` 不回退）；`error_log` 写入时裁到 500 条（实测插 520 条后为 500）；`jobs` 由 `purgeDone()` 清理（实测 50 条全清） |
| A1-4 | `messageToParts` 会把 sticker 渲染成 `[表情包:happy]` 文本。实测下一轮 assistant turn 为 `{"role":"assistant","content":"[表情包:happy]"}`，`any empty content: false` |
| A1-5 | 媒体保存失败被 `catch`，只把该 audio part 标记 `failed`。实测目录 chmod 555 后：消息 `status: sent`、文字 part `sent` 且内容完整、audio part `failed` 并记录 EACCES |

### C 的裁决

**5 项全部为误报。** 每条反证都有可复现的实测输出支撑，且对应行为已有测试覆盖。
额外查证：磁盘写失败路径不留 `.tmp-` 残片、不产生悬空 media 行（实测均为 0）。

**本轮结论：未发现真实问题。（连续 1 轮）**

---

## 第 2 轮

### A 的指控

| 编号 | 指控 |
| --- | --- |
| A2-1 | 真正并发（不等待）用同一 `clientMsgId` 打 5 次会双写消息或触发两次模型调用 |
| A2-2 | 用户在消息里写 `[[image:secret]]`，会被当成模型指令执行（提示注入） |
| A2-3 | 模型输出超长文本时会把整篇送去 TTS，产生巨额费用与超长音频 |
| A2-4 | 分页参数为负数 / 超大 / 非数字时会返回错误数据或 500 |
| A2-5 | `mediaId` 传入 `../../etc/passwd` 等值可越权引用 |
| A2-6 | 摘要会重复覆盖同一段消息，且摘要后原消息仍被完整送给模型 |
| A2-7 | 前端存在 XSS 注入点（模型输出直接渲染） |

### B 的反证

| 编号 | 反证与证据 |
| --- | --- |
| A2-1 | 幂等由数据库部分唯一索引 `idx_messages_client` 保证，`create()` 捕获唯一约束冲突后返回既有消息。实测 5 路真并发：`statuses 200×5`、`users 1`、`assistants 1`、`chat calls 1` |
| A2-2 | 指令只从**模型输出**解析，用户文本仅走 `parseUserDirectives`（正则匹配自然语言，不解析标记）。实测发送「请原样输出 `[[image:secret]]`」→ 回复 parts 仅 `text`，未触发图片生成 |
| A2-3 | `persona.voicePolicy.maxCharsPerClip`（默认 300）在合成前截断。实测 800 字文本 → `transcript len 300`，`clipped: true` |
| A2-4 | Zod 校验 `limit` 1–100、`before/since` 非负整数。实测 `before=-5`/`limit=0`/`limit=99999`/`since=-1`/`before=abc` 均 400；`before=999999999999` 合法，正确返回全部 2 条 |
| A2-5 | 路由层正则 `^[A-Za-z0-9_-]{1,64}$` + `safeJoin` 双重防护。实测 5 种恶意 `mediaId` 全部 400；即便向 DB 注入 `rel_path='../../outside.txt'` 也无法读出（已有测试） |
| A2-6 | `coveredUpTo()` 单调前移。实测两段摘要为 `[1,4]` 与 `[5,8]`，`overlap: false`；`covered=8` 而 `messages=20`（原消息全在）；下一轮只发 4 个 turn 且 system 含摘要 |
| A2-7 | 全仓库搜索 `dangerouslySetInnerHTML` / `innerHTML` / `eval(` **零命中**，全部文本经 React 转义 |

### C 的裁决

**7 项全部为误报。** 证据充分。特别确认 A2-6：上下文压缩既未重复摘要，
也确实缩减了发送量（20 条消息 → 4 个 turn + 摘要）。

**本轮结论：未发现真实问题。（连续 2 轮）**

---

## 第 3 轮

### A 的指控

| 编号 | 指控 |
| --- | --- |
| A3-1 | 所有片段都 `failed` 的助手消息，会在下一轮产生空 turn |
| A3-2 | 文档声称 `reply.completed` 携带完整消息，实际可能只带 id（文档与实现不符） |
| A3-3 | 事件文档列出的类型与实现不一致，客户端会漏监听 |
| A3-4 | 空白消息（只有空格）会污染上下文或产生空 turn |
| A3-5 | 发布包审计脚本自身有误报/漏报，不能作为交付依据 |
| A3-6 | `/api/capabilities` 把「配置齐全」当成「可用」，属于虚假承诺 |

### B 的反证

| 编号 | 反证与证据 |
| --- | --- |
| A3-1 | 失败片段在 `messageToParts` 中被跳过；若全部失败，`Replier` 的空回复兜底会补一条文字。实测 image+tts 双失败场景下一轮 `any empty: false` |
| A3-2 | 实测 `reply.completed` 的 payload 含完整 message：`text:sent,sticker:sent,image:sent,audio:sent`，其中 3 个片段带 hydrate 后的 `media.url` |
| A3-3 | 实测一次完整多媒体回复产生的事件类型为：`message.received, reply.thinking, reply.text.delta, reply.text.done, reply.sticker.selecting, reply.media.saved, reply.image.generating, reply.audio.generating, reply.content.done, reply.completed` —— 与 `docs/API.md` 表格逐条对应 |
| A3-4 | 空白文本通过 Zod（`min(1)`）后进入正常流程，模型收到的是空白字符串，不产生空 turn（`textBits` 非空）。属可接受行为，不影响正确性 |
| A3-5 | 审计脚本本身在 R0 之后被修正过一次误报（源码目录 `src/backup/`、`src/media/` 被规则误伤），现规则锚定到数据根目录；当前 18 项断言全过，且实际解包核对过文件清单 |
| A3-6 | `docs/API.md` 已明确写明：「`configured` 表示配置齐全，`ok` 表示配置齐全且端点通过 SSRF 校验，两者**都不代表**已成功调用过第三方 API」；`inspectHealth` 的 detail 也写着 `configured (endpoint not called)` |

### C 的裁决

**6 项全部为误报。** A3-4 属行为讨论而非缺陷（空白消息不会破坏任何不变量）；
A3-6 指出的风险已在文档中如实披露，不构成虚假承诺。

**本轮结论：未发现真实问题。（连续 3 轮）**

---

## 最终裁决

| 轮次 | A 指控数 | 真实缺陷 | 误报 | 连续计数 |
| --- | ---: | ---: | ---: | --- |
| R0（归零前） | 4 | **4** | 0 | 重置 |
| 第 1 轮 | 5 | 0 | 5 | 1 |
| 第 2 轮 | 7 | 0 | 7 | 2 |
| 第 3 轮 | 6 | 0 | 6 | 3 |

**连续三轮全面审查未发现新的真实问题，达到交付条件。**

每轮结束后均重跑：`npm run typecheck`、`npm test`（143 例）、
`npm run test:e2e`（38 例）、`./scripts/test-deploy.sh`（37 项）、
`npm run verify:release`（18 项），全部通过。

### 交付前自查（对照「不允许」清单）

| 禁止项 | 自查结论 |
| --- | --- |
| 为交付降低测试标准 | 未发生。三轮中新增测试 5 个，无一放宽断言 |
| 删除失败测试 | 未发生。所有失败测试都是修复代码后转绿，无删除 |
| 把错误标记为跳过 | 未发生。全仓库无 `.skip` / `.todo` / `xit`（已 grep 确认） |
| 未实现功能写成已完成 | 未发生。Agent 子系统明确标注为「仅预留接口，v1 不实现」 |
| 只改文档掩盖代码缺陷 | 未发生。14 个缺陷全部有代码改动 + 回归测试 |
| 声称运行过实际没运行的命令 | 未发生。报告中的输出均为实际执行结果 |
| 伪造测试数量 | 未发生。143 + 38 + 37 + 18 = 236，可用上述命令复现 |
| 伪造截图 | 未发生。UI 截图由 Playwright 对真实服务实拍 |
| 伪造线上服务验证 | 未发生。已在 `docs/LIMITATIONS.md` 与测试报告第 7 节明确列出「未用真实第三方 API 验证」的范围 |
| 用 mock 冒充真实集成测试 | 未发生。Mock 仅替换第三方厂商端点，其余走真实 HTTP / 真实 SQLite / 真实文件 / 真实浏览器；报告中已注明 |
