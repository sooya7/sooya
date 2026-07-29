# SOOYA PR #1 M-001～M-024 核验记录

| 编号 | 当前核验状态 | 证据与处理决定 |
|---|---|---|
| M-001 | 已被后续提交修复 | 构建阻断已修复，完整测试仍受其他问题影响。原始 Head `bd2db8b` 缺失 `media/store.ts`、`media/stickers.ts`；`09ac980` 仅同步必要模块，`9456767` 修复测试夹具的跨平台 `file:` URL 转换。 |
| M-002 | 确定存在 | Run 30435357087 的 E2E 连续超时，35 分钟 job timeout 后取消；诊断因 cancelled 被跳过。 |
| M-003 | 报告误判 | 模拟运行时超出唯一范围；事实库功能另按第 8 项核验。 |
| M-004 | 确定存在 | 正式回复直接 `synthesize(clipped)`，未读取保存的情绪映射。 |
| M-005 | 测试不足 | 待按 ContextBuilder 实际预算路径补充核验。 |
| M-006 | 确定存在 | 临时 HTTP/网络错误达到六次即删除订阅。 |
| M-007 | 已被后续提交修复 | 当前 ImageViewer 使用 Pointer Capture；仍需真机异常释放验证。 |
| M-008 | 无法确认 | 待核验预览与 apply 的报告绑定路径。 |
| M-009 | 无法确认 | 待核验文件与数据库删除补偿路径。 |
| M-010 | 已被后续提交修复 | `7afd647` 移除普通/管理媒体及 SSE 的长期 query token，改用分作用域 Bearer fetch + Blob URL；受保护媒体 network-only。相关自动化通过，完整 Server 聚合命令仍无汇总超时，原生移动端 Web Share 待真机验证。 |
| M-011 | 确定存在 | 媒体仓库使用 `value_json LIKE '%id%'`。 |
| M-012 | 测试不足 | 待核验 ZIP 实际内容。 |
| M-013 | 无法确认 | 待核验 SW 缓存键版本行为。 |
| M-014 | 真机待验证 | 历史状态需 E2E 复现。 |
| M-015 | 真机待验证 | 移动端滚动长按需复现。 |
| M-016 | 报告误判 | 当前实现并非报告假定的 touchmove passive 路径。 |
| M-017 | 无法确认 | 待核验 LIKE 转义实现与测试。 |
| M-018 | 无法确认 | 待核验归一化与数据库唯一约束。 |
| M-019 | 无法确认 | 待比较 preview 与 apply 统计。 |
| M-020 | 测试不足 | 待核验保存后 capability 刷新。 |
| M-021 | 测试不足 | 待大数据量 UI 验证。 |
| M-022 | 测试不足 | 待 2000 条导入事务验证。 |
| M-023 | 无法确认 | 待核验可见性同步失败补偿。 |
| M-024 | 测试不足 | 待 UI 选择态验证。 |

## M-001 取证

原始 Head 在干净 `npm ci` 后，Server typecheck 与 build 均报 `TS2307`，指向缺失的 `./media/store.js` 和 `./media/stickers.js`；服务端测试有 9 个套件无法导入。`09ac980` 同步的两个文件为完整实现而非空壳，与现有调用方接口一致，未从 `main` 带入其他改动。同步后 Server/Web typecheck 与 production build 均成功。

`9456767` 将 `test/helpers/harness.ts` 的 `new URL(...).pathname` 手动转换改为 Node `fileURLToPath()`。`npm run test -w @sooya/server -- --run test/unit.test.ts` 为 35/35 通过并正常退出，原先的 Windows `C:\C:\...` 已消失；`test/regression.test.ts` 为 25/26，剩余 `keeps the backup helper syntactically valid` 是下述 Windows/WSL 参数互操作阻塞，不属于 `fileURLToPath()` 修复。当前不得把 M-001 记为整个阶段全面通过。

## M-002 取证

GitHub Actions Run `30435357087` 的 E2E 自 08:26:27 运行，多个用例每次超时 60 秒并重试；08:59:33 输出 `The operation was canceled`。工作流 job 配置 `timeout-minutes: 35`，时间线符合 job 超时。并发策略虽启用 `cancel-in-progress`，但没有后继 run 覆盖该 run 的证据。

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
