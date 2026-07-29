# SOOYA PR #1 M-001～M-024 核验记录

| 编号 | 当前核验状态 | 证据与处理决定 |
|---|---|---|
| M-001 | 已被后续提交修复 | 构建阻断已修复，完整测试仍受其他问题影响。原始 Head `bd2db8b` 缺失 `media/store.ts`、`media/stickers.ts`；`09ac980` 仅同步必要模块，`9456767` 修复测试夹具的跨平台 `file:` URL 转换。 |
| M-002 | 已被后续提交修复 | Run 30435357087 的 E2E 连续超时并耗尽 35 分钟；`772c2a4` 修复测试直连 API 缺少 Bearer、静默忽略非 2xx、功能中心移动导航缺失、旧路由/图标定位契约及乐观消息竞态。本地根命令 62/62 通过，最新 Head 的 Linux Actions 仍待确认。 |
| M-003 | 报告误判 | 模拟运行时超出唯一范围；事实库功能另按第 8 项核验。 |
| M-004 | 已被后续提交修复 | `3cb4640` 抽取统一语音参数解析链路；试听与正式回复都读取已保存映射，自动情绪别名映射到 UI 预设，缺失预设安全回退中性。 |
| M-005 | 已被后续提交修复 | `14eb215` 按模型 context window、输出上限和安全余量建立统一输入预算；摘要、记忆、世界事实和近期消息按预算纳入，高权威世界事实优先，预算与 dropped counts 持久化。 |
| M-006 | 已被后续提交修复 | `4a65013` 限制自动删除为 404/410；500、503、网络、DNS、TLS 临时失败只累计诊断计数，不删除订阅，成功后计数归零。 |
| M-007 | 已被后续提交修复 | `898bb0a` 用同步 drag ref 消除快速 pointermove→pointerup 读取旧 React state 的竞态；真实 CDP touch 连续 3/3、双端功能 10/10、完整 E2E 66/66。物理设备惯性、系统返回与异常 capture 释放仍待真机。 |
| M-008 | 已被后续提交修复 | `d044681` 为清理预览生成持久化 reportId、策略/候选 hash；管理端 apply 必须提交已确认报告，只处理快照候选并逐项二次校验。 |
| M-009 | 已被后续提交修复 | `c03c6c2` 不再吞掉媒体文件删除错误；单删、批量删和孤立上传收集失败均保留 DB 记录并返回/记录明确失败。 |
| M-010 | 已被后续提交修复 | `7afd647` 移除普通/管理媒体及 SSE 的长期 query token，改用分作用域 Bearer fetch + Blob URL；受保护媒体 network-only。相关自动化通过，完整 Server 聚合命令仍无汇总超时，原生移动端 Web Share 待真机验证。 |
| M-011 | 已被后续提交修复 | `13286b1` 将世界数据媒体引用从模糊 `LIKE` 改为 `json_tree` 对 `mediaId/media_id` 文本值的精确匹配，并同步引用统计、未引用清理和孤立上传扫描。 |
| M-012 | 报告误判 | 唯一清单要求“批量导出与选择一致”，未要求 ZIP 格式；当前逐项安全 Blob 下载已由 M-010 自动化覆盖，不新增 ZIP 范围。 |
| M-013 | 已被后续提交修复 | `7afd647` 后受保护媒体全部 network-only，Service Worker 不再建立忽略 `?v=` 的媒体缓存键；激活时清理旧敏感缓存。 |
| M-014 | 报告误判 | 新增双端 E2E 证明已有 history state 被保留；打开只增加一个 viewer entry；Desktop 按钮/Mobile 真实 touch 切图不增加条目；浏览器返回、关闭按钮及再次打开均恢复原 state，未复现历史污染。 |
| M-015 | 已被后续提交修复 | `5192ccb` 将触摸长按统一为可取消 press session；父级/窗口 scroll、位移阈值、pointerup、pointercancel、lostpointercapture、页面隐藏、失焦和 unmount 均对称清理，过期 timer 不再打开菜单。真实 Pointer Events 自动化通过，iOS/Android 真机滚动手感仍待验收。 |
| M-016 | 报告误判 | 当前实现并非报告假定的 touchmove passive 路径。 |
| M-017 | 已被后续提交修复 | `b852e3b` 将世界管理搜索和 Context 相关性搜索统一改为 `LIKE ? ESCAPE '\'`，`\`、`%`、`_` 通过共享 helper 字面转义。 |
| M-018 | 已被后续提交修复 | `b852e3b` 新增持久化 Unicode identity key、迁移回填/重复 winner 选择及活动 canonical 部分唯一索引。 |
| M-019 | 已被后续提交修复 | `006a0d6` 仅把本次可直接删除的媒体计入 reclaimableBytes；执行分别返回 deletedBytes 与 skippedBytes，预览/执行口径可核对。 |
| M-020 | 报告误判 | `featureApi.updateVoice()` 当前在 PUT 成功后立即重新 GET 完整 voice 状态，VoiceEditor 用新响应替换 state。`860449b` 补 Desktop/Mobile E2E，确认保存后 GET 至少执行第二次、capability 文案和试听状态继续由刷新结果渲染。 |
| M-021 | 已被后续提交修复 | `36a0543` 用分类摘要和每页 50 条明细替换完整 JSON `<pre>`；完整原始报告按需下载。2000 候选双端 E2E 证明 DOM 只渲染当前页、翻页正确、下载 Blob/文件名正确。 |
| M-022 | 确定存在，已修复 | `WorldEngine.import()` 原先逐条调用 `WorldRepo.apply()`，后续失败会留下此前已提交条目；`8a733be` 改为单一批量事务，并覆盖 2000 条、回滚、合并、冲突和禁用计数。 |
| M-023 | 确定存在，已修复 | `NotificationBridge` 原先永久吞掉 visibility 同步失败；`a4a9fdc` 增加有限重试、最新状态补偿、重新读取鉴权和卸载清理。系统级 Push 仍待真机。 |
| M-024 | 测试不足 | 待 UI 选择态验证。 |

## M-001 取证

原始 Head 在干净 `npm ci` 后，Server typecheck 与 build 均报 `TS2307`，指向缺失的 `./media/store.js` 和 `./media/stickers.js`；服务端测试有 9 个套件无法导入。`09ac980` 同步的两个文件为完整实现而非空壳，与现有调用方接口一致，未从 `main` 带入其他改动。同步后 Server/Web typecheck 与 production build 均成功。

`9456767` 将 `test/helpers/harness.ts` 的 `new URL(...).pathname` 手动转换改为 Node `fileURLToPath()`。`npm run test -w @sooya/server -- --run test/unit.test.ts` 为 35/35 通过并正常退出，原先的 Windows `C:\C:\...` 已消失；`test/regression.test.ts` 为 25/26，剩余 `keeps the backup helper syntactically valid` 是下述 Windows/WSL 参数互操作阻塞，不属于 `fileURLToPath()` 修复。当前不得把 M-001 记为整个阶段全面通过。

## M-002 取证

GitHub Actions Run `30435357087` 的 E2E 自 08:26:27 运行，多个用例每次超时 60 秒并重试；08:59:33 输出 `The operation was canceled`。工作流 job 配置 `timeout-minutes: 35`，时间线符合 job 超时。并发策略虽启用 `cancel-in-progress`，但没有后继 run 覆盖该 run 的证据。

后续 Run `30445900732` 在旧 Head `600c542` 上形成真实失败结论：Browser E2E 为 49/62 通过、11 失败、2 flaky；依赖审计、独立代码验证、发布包和容器验证均成功。失败并非 Runner 中断或人工取消。

`772c2a4 fix(web): stabilize authenticated browser flows` 完成以下闭环：

- E2E 服务端直连消息请求携带 `Authorization: Bearer`，并对所有非 2xx 立即报错；旧测试此前静默忽略 401，最终表现为页面无消息和 15 秒 locator 超时。
- 历史分页、阅读位置保持和断线补偿在 Desktop/Mobile 均通过。
- 功能入口断言与 `/admin/features` 真实路由一致，恢复锁页、未读提示和六齿图标稳定语义定位。
- 功能中心补齐移动端四项导航；世界事实夹具按 Playwright project 唯一化，避免 Desktop 数据污染 Mobile。
- 引用/撤回测试等待每次消息 POST 成功及最终 sent 状态，不再把正确的防重复提交锁误判为 UI 卡死。

验证：

- `npm run test -w @sooya/web`：2 files、17/17 通过。
- `npm run typecheck -w @sooya/web`：通过。
- `npm run build -w @sooya/web`：production build 通过。
- `npm run test:e2e -- --reporter=list`：62/62 通过，Desktop 31/31、Mobile 31/31，耗时 2.0 分钟，正常退出，无 skip/fixme。

因此本地 Browser 自动化基线已恢复；只有最新 Head 的 Linux Actions 成功后，才可把 CI 门槛记为完成。

## M-015 修复与验证

提交：`5192ccb fix(chat): cancel long press on scroll`。

失败证据：Mobile Playwright 对真实消息派发 touch `pointerdown`，父滚动容器随后触发 `scroll` 且没有额外 `pointermove`；旧实现等待 650ms 后仍错误显示消息操作菜单，定向测试 1/1 失败。

修复后：

- 每次 pointerdown 先取消旧 press session，timer 回调只接受当前 pointerId，旧回调不能打开菜单。
- 位移超过 9px、任意捕获阶段 scroll、pointerup、pointercancel、lostpointercapture、window blur、document hidden 统一取消。
- effect teardown 移除全局监听并取消 timer，组件卸载后无迟到菜单或 page error。
- 正常静止长按仍会在 520ms 后打开菜单，防回归测试不是通过永久禁用长按伪造。

验证：

- RED：`npx playwright test e2e/features-1-9.e2e.ts --project=mobile --grep "scrolling cancels" --reporter=list`，菜单实际 visible、预期 hidden。
- GREEN：同一命令 1/1 通过。
- 功能回归：`npx playwright test e2e/features-1-9.e2e.ts --reporter=list`，Desktop/Mobile 8/8 通过。
- `npm run test -w @sooya/web`：17/17；Web typecheck、production build 通过。
- `npm run test:e2e -- --reporter=list`：Desktop 32/32、Mobile 32/32，共 64/64，2.2 分钟正常退出。

限制：自动化使用 Chromium 的真实 Pointer Events 路径，但不能替代 iOS Safari 与 Android Chrome 的物理滚动惯性和系统手势验收。

## M-007 / M-014 查看器手势与历史复核

提交：`898bb0a fix(gallery): stabilize fast swipe gestures`。

M-014 复核覆盖页面预先存在自定义 history state、打开查看器、切换图片、浏览器返回、再次打开和关闭按钮。Desktop 与 Mobile 均证明 viewer 只使用一个附加条目，图片切换数量不影响 history.length，关闭后原 state 完整恢复。因此 M-014 记为报告误判，不实现额外 history 管理器。

复核中确认 M-007 的独立竞态：pointermove 通过 `setDrag()` 异步更新位移，紧随其后的 pointerup 从旧 render 闭包读取 `drag=0`，快速滑动可能不切图。修复用同步 `dragRef` 记录本次 gesture 的最终位移，reset/finish 同步归零；渲染 state 只负责动画展示。

验证：

- Mobile 使用 Chromium `Input.dispatchTouchEvent` 产生真实 touchStart/touchMove/touchEnd，连续 3/3 通过。
- `npx playwright test e2e/features-1-9.e2e.ts --reporter=list`：Desktop/Mobile 10/10。
- `npm run test:e2e -- --reporter=list`：Desktop 33/33、Mobile 33/33，共 66/66，2.2 分钟正常退出。
- Web unit 17/17、typecheck、production build 通过。

限制：iOS Safari/Android Chrome 物理设备的系统返回键、惯性、双指和异常 pointer capture 释放仍按真机矩阵验收。

## M-020 capability 刷新复核

提交：`860449b test(voice): verify capability refresh after save`。

`featureApi.updateVoice()` 不是直接采用 PUT 的部分响应：它先等待 PUT 成功，再调用 `GET /api/admin/voice`，该接口重新读取 `services.capabilities.statuses().tts`、policy、model、emotions 和 supported 参数；VoiceEditor 随后以完整响应替换本地 state。

E2E 在 Desktop/Mobile 均记录 voice GET 次数，保存后要求至少两次（初始加载 + 保存后刷新），并断言 capability 文案和试听按钮仍按刷新结果可用。定向命令 `npx playwright test e2e/features-1-9.e2e.ts --grep "feature center exposes" --reporter=list` 为 2/2 通过。因此报告假定的 capability 过期路径不存在，M-020 记为报告误判。

## M-021 大清理报告渲染

提交：`36a0543 fix(storage): paginate large cleanup reports`。

失败证据：返回包含 2000 个 orphanFiles 的合法 cleanup report 后，旧 StorageEditor 不存在摘要/分页节点，而是同步 `JSON.stringify` 整份报告并渲染到单个 `<pre>`；新增测试在 `cleanup-report-summary` 不存在处失败。

修复后：

- 按六类候选显示数量和字节摘要，同时显示总项数、可释放空间与 reportId。
- 明细扁平化后每页最多 50 行；DOM 不包含未进入当前页的第 2000 条记录。
- 上一页/下一页有边界禁用和明确页码；报告替换时回到第一页。
- 完整原始 JSON 只在用户点击下载时序列化，使用临时 Blob URL 和受控 `${reportId}.json` 文件名。
- 执行安全清理仍引用原始 result state 中的 reportId，不改变 M-008 的确认报告绑定。

验证：RED 为摘要节点不存在；GREEN 双端大报告 2/2、功能中心 12/12、完整 E2E 68/68（2.3 分钟）。Web unit 17/17、typecheck、production build 通过。

## Windows 本地环境阻塞

`test/regression.test.ts` 的 Bash 语法测试在 Windows 下执行 `bash -n C:\\Users\\iulze\\Desktop\\sooya\\deploy\\backup.sh` 时失败；尝试使用 `wsl.exe wslpath -a` 也失败，WSL 实际收到 `C:UsersiulzeDesktopsooyadeploybackup.sh`。该环境无法传递 Windows 路径，未将 WSL 特例写入测试。Linux CI 仍原生执行 Bash 语法检查；此项仅标记为本机环境阻塞，不能视为通过。

## M-010 修复与验证

提交：`7afd647 fix(security): remove admin tokens from media URLs`。

实现证据：

- Server 的 `extractToken()` 仅接受专用 Header 或 `Authorization: Bearer`，不再接受 `token` / `admin_token` query；普通 token 不能访问管理 API。
- `authenticatedMedia.ts` 与 `useAuthenticatedMedia.ts` 统一普通/管理两种作用域，校验状态码、Content-Type、空 Blob、跨域目标与 Object URL 创建失败；Abort、过期请求、替换和卸载均有清理。
- 聊天图片、音频、贴纸、双方头像、管理头像、图库、查看器、单个/批量下载、TTS 试听和分享降级均迁移到无凭证 URL 或 Blob URL。
- SSE 从带 query token 的 `EventSource` 改为带 Bearer Header 的 fetch 流；`lastEventId` 仍为非秘密查询参数。
- Service Worker 升级为 `sooya-v6`，清理旧版本缓存，`/api/media/*` 采用 network-only；Server 媒体响应为 `Cache-Control: private, no-store`。
- 图片查看器操作区不再被根节点 Pointer Capture 截获，真实指针保存/分享路径已由 Playwright 覆盖。
- `docs/API.md` 已删除 `?token=` 作为正式鉴权方式的示例，明确普通 API、媒体与 SSE 均使用 Header，避免文档继续引导不安全客户端。

自动化证据：

- `npm run test -w @sooya/web`：2 files，17/17 通过，正常退出。
- `npm run typecheck -w @sooya/web`、`npm run build -w @sooya/web`：通过。
- `npm run typecheck -w @sooya/server`、`npm run build -w @sooya/server`：通过。
- `npm run test -w @sooya/server -- --run test/security.test.ts test/unit.test.ts test/features-1-9.test.ts`：3 files，72/72 通过。
- `npm run test -w @sooya/server -- --run test/chat.test.ts`：37/37 通过，约 118 秒，正常退出。
- `npm run test -w @sooya/server -- --run test/media-autonomy.test.ts`：3/3 通过。
- `npm run test -w @sooya/server -- --run test/stream.test.ts`：6/6 通过。
- `npx playwright test --project=desktop --grep "generates and displays an image|playable voice message|feature center exposes|gallery supports|service worker keeps protected media" --reporter=list`：5/5 通过。断言普通/管理 Bearer Header、Blob DOM、无 token URL/DOM、Blob 生命周期、下载/分享安全降级和 Cache Storage 无受保护媒体。

限制：`npm run test -w @sooya/server` 的完整聚合运行在外层 364 秒超时前未输出最终 Vitest 汇总，因此不能记为完整 Server 套件通过；上述 M-010 直接相关文件均已拆分通过。原生 iOS/Android Web Share、移动浏览器 Blob 生命周期仍标记为真机待验证。

## M-011 修复与验证

提交：`13286b1 fix(storage): use exact structured media references`。

失败证据：新增测试首次运行时，`media_abc` 在仅有普通 JSON 文本提及和正式引用 `media_abcd` 的情况下被旧 `LIKE '%media_abc%'` 统计为 2 个世界引用，预期为 0。

修复后：

- `world_entries.value_json` 仅在有效 JSON 中递归查找 key 为 `mediaId` / `media_id`、type 为 text、value 与媒体 ID 完全相等的字段。
- `media_abc` 不再匹配 `media_abcd`；普通 `note` 文本提及不算引用；嵌套正式字段精确阻止删除。
- 消息 `message_parts.media_id`、贴纸 `stickers.media_id` 继续使用精确外键字段。
- SOOYA 头像和用户头像继续由 Persona URL 的精确媒体 ID 解析保护；两种头像的永久删除均返回 409。
- 禁用世界条目不计引用；损坏的历史 `value_json` 通过 `json_valid` 安全忽略，不中断清理。
- 所有消息、贴纸、世界字段和头像引用解除后，永久删除返回 200 且媒体记录消失。
- 同一精确逻辑覆盖 `references()`、`listUnreferenced()` 和 `listOrphanUploads()`，避免统计正确但清理路径仍误判。

验证：

- 首次 RED：`npm run test -w @sooya/server -- --run test/media-references.test.ts`，1 failed，实际 worldEntries=2、预期 0。
- GREEN：同一命令 1/1 通过，正常退出。
- 回归：`npm run test -w @sooya/server -- --run test/media-references.test.ts test/features-1-9.test.ts`，2 files、7/7 通过。
- `npm run typecheck -w @sooya/server`、`npm run build -w @sooya/server`：通过。

## M-006 修复与验证

提交：`4a65013 fix(push): preserve subscriptions on temporary failures`。

失败证据：新增测试首次运行到第 6 次临时失败时，旧实现一次删除 5 个仍有效的订阅，`summary.removed` 实际为 5、预期为 0。

覆盖：

- 404、410 首次响应即删除；
- 500、503 连续 7 次仍保留；
- 普通网络异常、`EAI_AGAIN` DNS 临时失败、`ECONNRESET` TLS/连接临时失败连续 7 次仍保留；
- 每次临时失败增加 `fail_count` 并计入 `failed`，不计入 `removed`；
- 临时失败后成功投递返回 delivered，并将该订阅 `fail_count` 重置为 0；
- 最终状态断言确认 404/410 记录不存在，其他订阅仍存在。

验证：

- 首次 RED：`npm run test -w @sooya/server -- --run test/push-retry.test.ts`，1 failed，第 6 次实际 removed=5。
- GREEN：同一命令 1/1 通过。
- 回归：`npm run test -w @sooya/server -- --run test/push-retry.test.ts test/features-1-9.test.ts`，2 files、7/7 通过。
- `npm run typecheck -w @sooya/server`、`npm run build -w @sooya/server`：通过。

## M-004 修复与验证

提交：`3cb4640 fix(tts): apply saved emotion mappings to replies`。

失败证据：新增集成测试首次运行时，试听调用携带已保存的 `happy` 参数 `{ emotion: 'happy', instructions: '保存的开心指令', speed: 1.23 }`，正式机器人语音却调用 `synthesize('哈哈，太好了！', undefined)`，证明两条路径未共享保存的映射。

修复后：

- 新增 `core/voice.ts`，集中维护默认预设、自动检测情绪到 UI 保存键的别名映射及最终参数解析。
- 管理端试听和正式回复均通过 `resolveVoiceDelivery()` 解析 `emotion`、`instructions`、`speed`，不再维护两套参数链路。
- 正式回复在每次生成语音前从 `SettingsRepo` 读取 `voice.emotions`，保存后无需重启即可生效。
- `happy` / `playful` 映射到 `happy`，`comforting` / `sleepy` / `warm` 映射到 `gentle`，其余受支持情绪映射到对应预设或 `neutral`。
- 明确请求未知预设、或自动检测到的预设未保存时，情绪键和参数同时回退 `neutral`，不会出现“情绪名与中性参数不一致”。
- 最终状态断言验证正式回复和持久化消息中的音频部分均为 `sent`，并带有真实 `mediaId`；既有 TTS 失败、voice-only、禁用语音和媒体持久化回归继续通过。

验证：

- 首次 RED：`npm --workspace packages/server test -- --run test/voice-mapping.test.ts --reporter=verbose`，正式回复的第二次 TTS 调用 options 实际为 `undefined`。
- 回退异常路径 RED：同一测试中，缺失 `happy` 预设时曾返回 `emotion: happy` 配中性参数；修复后情绪键与参数统一回退。
- GREEN 与相关回归：`npm --workspace packages/server test -- --run test/voice-mapping.test.ts test/features-1-9.test.ts test/tts-expression.test.ts --reporter=verbose`，3 files、13/13 通过，约 24.5 秒，正常退出。
- 完整聊天回归：`npm --workspace packages/server test -- --run test/chat.test.ts --reporter=verbose`，1 file、37/37 通过，约 117.4 秒，正常退出。
- `npm --workspace packages/server run typecheck`、`npm --workspace packages/server run build`：通过。

限制：本项相关自动化已通过；清单第 7 项仍包含移动端真实试听体验，需随整体验收在真机确认，不能据此宣布功能 1–9 全部验收完成。

## M-005 修复与验证

提交：`14eb215 fix(context): enforce model input token budgets`。

失败证据：

- 首次 RED：小上下文窗口测试得到 `built.inputBudget === undefined`，确认原实现只按固定条数取 4 个摘要、`memoryLimit` 条记忆、18 条世界事实和 `recentMessages` 条消息。
- 第二个 RED：3000 字的最新用户消息在小窗口下被整个丢弃，`built.turns` 实际长度为 0、预期为 1。

修复后：

- Replier 从实际聊天/视觉模型配置读取 `contextWindow` 与 `maxTokens`，为输出和 128-token 安全余量预留空间；请求输出上限不会超过当前实际使用 provider 的配置。
- ContextBuilder 对中日韩文字和其他文本采用保守估算，图片按固定高成本计入；最终 `estimatedInputTokens <= inputBudget`。
- Persona 保留最高基础份额；近期消息从最新向前纳入；摘要、召回记忆和世界事实逐项检查预算；世界事实继续沿用 authority、confidence、relevance 排序。
- 18 条超长世界事实在 972-token 输入预算下只纳入可容纳的前几条，用户明确设定优先保留；禁用或冲突条目仍不进入上下文。
- 超长最新用户消息会转换为仍包含请求开头的有界文本，不会因单条超预算而整轮消失。
- 助手消息 `meta.contextBudget` 持久化输入预算、估算使用量、请求输出上限及摘要/记忆/世界/近期消息 dropped counts，便于后续诊断。

验证：

- `npm --workspace packages/server test -- --run test/context-budget.test.ts --reporter=verbose`：3/3 通过，约 9.9 秒，正常退出。
- `npm --workspace packages/server test -- --run test/context-budget.test.ts test/features-1-9.test.ts test/memory.test.ts --reporter=verbose`：3 files、25/25 通过，约 84.7 秒，正常退出。
- `npm --workspace packages/server test -- --run test/chat.test.ts --reporter=verbose`：1 file、37/37 通过，约 112.8 秒，正常退出。
- `npm --workspace packages/server run typecheck`、`npm --workspace packages/server run build`：通过。

限制：预算使用跨 provider 的保守估算而非绑定单一厂商 tokenizer；128-token 安全余量用于降低不同模型分词差异造成的溢出风险。模型服务仍应返回并监控实际 usage。

## Windows 数据库恢复基线修复

提交：`6632637 fix(db): close failed database handles on recovery`。

组合回归暴露两个既有 Windows 失败：损坏数据库在 `applyPragmas()` 抛出 `SQLITE_NOTADB` 后，`tryOpen()` 未关闭刚创建的 SQLite 句柄；Windows 文件锁使 quarantine/删除原文件失败，fresh recovery 再次打开同一损坏库。修复在 pragma 失败路径关闭句柄并保留原始异常。

验证：`npm --workspace packages/server test -- --run test/reliability.test.ts --reporter=verbose` 从 19/21（2 个 `SQLITE_NOTADB`）恢复为 21/21，约 52.5 秒，正常退出；Server typecheck/build 通过。

## M-009 修复与验证

提交：`c03c6c2 fix(storage): preserve media records on delete failures`。

失败证据：模拟 `fs.rm` 拒绝删除正式媒体文件时，旧 API 仍返回 200，随后数据库记录消失而文件仍存在。

修复后：

- `MediaStore.delete()` 只有文件删除成功后才删除数据库记录；任一步失败都会抛出，不再空 catch 后继续。
- 若数据库删除在文件删除后失败，操作同样返回失败且记录仍存在，可由 missing-record/reconcile 路径追踪处理。
- 单文件永久删除返回 500 `media_delete_failed`，错误文本不暴露真实路径；写入 error log 与 `permanent.delete_failed` 审计。
- 批量永久删除逐项隔离，失败项进入 `failed`，不计入 `changed`，其他独立媒体继续处理；最终批量审计包含失败结果。
- `collectOrphans()` 文件删除失败时不删除数据库行并向维护 Job 抛错，避免后台任务静默制造孤立文件。

验证：

- 首次 RED：`npm --workspace packages/server test -- --run test/media-delete-consistency.test.ts --reporter=verbose`，预期 500、实际 200。
- GREEN：同一命令 3/3 通过，覆盖单删、批量部分失败、孤立上传收集失败及最终 DB/文件状态。
- 回归：`npm --workspace packages/server test -- --run test/media-delete-consistency.test.ts test/features-1-9.test.ts test/media-references.test.ts --reporter=verbose`，3 files、10/10 通过，约 32.5 秒，正常退出。
- `test/reliability.test.ts` 21/21 通过；Server typecheck/build 通过。

## M-008 修复与验证

提交：`d044681 fix(storage): bind cleanup apply to confirmed reports`。

失败证据：

- 预览响应没有 reportId，测试实际得到 `undefined`。
- 管理 API 直接提交 `{ apply:true }` 返回 200 并重新生成候选，预期应拒绝未确认的正式清理。

修复后：

- 每份预览生成并持久化 `reportId`、`generatedAt`、策略 SHA-256、候选 SHA-256、候选快照和可释放字节数；历史快照有数量与一小时有效期限制。
- 管理 API 的 apply 必须提交合法 reportId；缺失、过期、策略变化或候选 hash 不一致均返回 409，要求重新预览。
- 管理页面保存预览响应并在二次确认后把同一 reportId 传给 apply，不再只发送 `apply:true`。
- apply 只遍历快照中的候选；预览后新增 orphan 不会被旧报告删除。
- 删除前重新检查媒体引用、双方头像、删除状态、记录大小/路径，以及文件实际路径、大小、mtime；新增引用或文件变化进入带原因的 `skipped`。
- preview 与 apply 审计均记录 reportId、策略/候选 hash；apply 额外记录 deleted、skipped、releasedBytes。
- 定时维护显式使用内部即时报告路径，不伪装成用户确认清理。

验证：

- 首次 RED：`npm --workspace packages/server test -- --run test/storage-cleanup-report.test.ts --reporter=verbose`，2/2 失败（无 reportId、无报告 apply 假成功）。
- GREEN：同一文件 4/4 通过，覆盖旧快照不删除新增 orphan、无 reportId 拒绝、文件变化跳过、媒体新增引用后跳过及审计 reportId。
- 回归：`npm --workspace packages/server test -- --run test/storage-cleanup-report.test.ts test/media-delete-consistency.test.ts test/features-1-9.test.ts --reporter=verbose`，3 files、13/13 通过，约 40.2 秒，正常退出。
- Web 测试 17/17；Server/Web typecheck 与 production build 均通过。

## M-012 / M-013 范围裁定

- M-012：严格按《SOOYA 1–9 功能实施清单与验收标准》，批量导出必须与选择集合一致、排除不应导出的回收站内容，但清单未指定 ZIP。当前逐项鉴权 Blob 下载属于满足该功能语义的浏览器兼容实现，并已在 M-010 覆盖下载地址无 token、受控文件名和清理；“必须生成 ZIP”记录为报告误判/扩范围，不引入新依赖。
- M-013：旧实现将媒体 query 归一化为 pathname 缓存，确有版本污染风险；`7afd647` 已把 `/api/media/*` 改为 network-only、Blob URL 不经过 Service Worker、`sooya-v6` 激活删除旧缓存。因此该问题属于已被后续提交修复，不再为 `?v=` 建媒体 Cache API key。

## M-017 / M-018 修复与验证

提交：`b852e3b fix(world): stabilize identities and literal search`。

失败证据：

- M-017：搜索 `100%` 时旧查询同时返回字面 `100%` 与 `1000` 记录；`_` 同样匹配任意单字符。
- M-018：先写入 `Straße角色 / IST伙伴`，再写入 `STRAẞE角色 / ist伙伴` 时，第二次 `merged` 实际为 0，并产生两个活动事实；表中不存在持久化 identity key。

修复后：

- 新增共享 `literalContainsPattern()`，媒体与世界搜索统一转义 `\`、`%`、`_`；世界 list/relevant SQL 明确使用 `ESCAPE '\'`。
- 新增 locale-independent `worldIdentityKey()`：NFKC、trim、Unicode lowercase、空白归一化；对话提取、导入、管理创建和更新共用同一键。
- schema v5 新增 `subject_key` / `predicate_key`；升级时回填既有记录，并按 authority、confidence、updatedAt、id 选择活动 winner，其他重复项转为冲突历史。
- 部分唯一索引保证同一 identity 最多一个 `active=1 AND conflict_of IS NULL` canonical；冲突替换顺序调整为事务内先停用旧 winner，再插入新 winner。

验证：

- RED：`world-search.test.ts` 中 `100%` 实际返回 2 条、预期 1；`world-normalization.test.ts` 中 Unicode 变体未合并且 key 为 undefined。
- GREEN/回归：`npm --workspace packages/server test -- --run test/migration-rollback.test.ts test/world-normalization.test.ts test/world-search.test.ts test/features-1-9.test.ts --reporter=verbose`，4 files、12/12 通过，约 29.1 秒，正常退出。
- 升级测试从 schema v4 构造既有 Unicode 活动重复项，v5 正确选择 user/高 confidence winner，并验证数据库唯一索引拒绝第二个活动 canonical。
- Server typecheck/build 通过。

## M-019 修复与验证

提交：`006a0d6 fix(storage): align cleanup preview with deletable bytes`。

失败证据：活动且未引用的正常图库媒体出现在 `unreferencedMedia`，并被计入 `reclaimableBytes`；但 apply 对同一项目要求 `deleted_at`，因此预览承诺的释放量无法兑现。

修复后：

- `unreferencedMedia` 清理候选只包含已进入回收站、当前无消息/贴纸/世界/头像引用的媒体；活动媒体不再被描述为本次可直接释放。
- 回收站未引用媒体的预览 `reclaimableBytes` 与成功执行的 `releasedBytes/deletedBytes` 一致。
- 预览后文件变化、引用变化等安全跳过累计到 `skippedBytes`，并保留逐项 category/target/reason；missing DB record 不虚构磁盘释放字节。
- apply 审计同时记录 deletedBytes、skippedBytes、deleted 和 skipped，差异可解释。

验证：

- RED：活动未引用媒体实际出现在候选并计入字节，预期不应成为直接删除候选。
- GREEN：`storage-cleanup-report.test.ts` 5/5 通过，新增活动媒体、回收站媒体和预览/执行字节一致性断言。
- 回归：`npm --workspace packages/server test -- --run test/storage-cleanup-report.test.ts test/media-delete-consistency.test.ts test/features-1-9.test.ts --reporter=verbose`，3 files、14/14 通过，约 43.8 秒，正常退出。
- Server typecheck/build 通过。

## M-022 修复与验证

提交：`8a733be fix(world): make imports atomic`。

失败证据：

- `WorldEngine.import()` 对每个条目分别调用一次带事务的 `WorldRepo.apply()`，因此事务边界仍然是单条而不是整批。
- 故障注入测试在第二条 `INSERT` 执行 `RAISE(ABORT)`；旧实现抛错后数据库实际仍有 1 条，预期为 0。

修复后：

- `WorldRepo.importEntries()` 在一个 SQLite 事务内完成整批写入、去重合并、冲突 winner 选择和 `active:false` 禁用。
- 任一条写入失败会回滚本批此前所有写入和状态变更。
- 2000 条导入返回 `{ stored: 2000, merged: 0, conflicts: 0, disabled: 0 }`，最终数据库为 2000 条。
- 混合导入返回确定的 stored/merged/conflicts/disabled 计数，并断言最终 active/inactive 状态。

验证：

- RED：`npm test -- --run test/world-import.test.ts --reporter=verbose`，1/3 失败；回滚用例期望 0、实际 1，2000 条用例约 4.23 秒。
- GREEN：同一命令 3/3 通过，正常退出；2000 条用例约 3.56 秒。
- 回归：`npm test -- --run test/world-import.test.ts test/world-normalization.test.ts test/world-search.test.ts test/features-1-9.test.ts --reporter=verbose`，4 files、12/12 通过，约 44.19 秒，正常退出。
- `npm run typecheck`、`npm run build`（`packages/server`）：通过。

## M-023 修复与验证

提交：`a4a9fdc fix(push): retry visibility synchronization`。

失败证据：

- `NotificationBridge` 的首次同步、`visibilitychange`、focus 和 blur 请求均以 `.catch(() => undefined)` 结束。
- RED 等价抽取保留旧行为后，临时失败测试预期 3 次、实际 1 次；耗尽后状态变化补偿测试预期累计 4 次、实际 2 次。

修复后：

- 每次状态变化立即同步当前前台状态；失败按 250ms、1000ms 有限重试，总尝试数最多 3 次，不无限重试、不显示骚扰性错误。
- 新状态事件取消旧状态的待重试计时器并立即发送最新状态，避免旧状态覆盖新状态。
- 三次失败耗尽后保持静默，但下一次 visibility/focus/blur 事件会重新开始同步。
- 每次重试重新构造 Push API 请求头并读取当前会话 token；测试覆盖首次 401 后使用刷新 token 成功重试。
- 组件卸载会取消待重试计时器，已卸载控制器不再发送。

验证：

- RED：`npm test -- --run src/lib/visibilitySync.test.ts --reporter=verbose`，2/4 失败，实际调用数分别为 1 和 2。
- GREEN：同一文件扩展为 5 个用例后 5/5 通过。
- Web 全量：`npm test`，3 files、22/22 通过。
- `npm run typecheck`、`npm run build`（`packages/web`）：通过。

限制：桌面自动化没有真实浏览器 PushManager 和系统通知通道；前台重复通知的最终系统级行为仍列入 iOS/Android PWA 真机验收。
