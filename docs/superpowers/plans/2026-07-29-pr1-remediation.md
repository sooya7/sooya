# SOOYA PR #1 Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 核验 M-001～M-024，并在 1–9 清单范围内修复已确认的自动化缺陷。

**Architecture:** 将审查结论与实现分离：先在隔离 Head 中建立可复现基线与 CI 证据，再在工作分支按 TDD 修复服务端安全路径和前端鉴权路径。世界引擎仅处理事实库，不实现模拟世界运行时。

**Tech Stack:** TypeScript、Fastify、SQLite/better-sqlite3、Vitest、React、Playwright、GitHub Actions。

---

### Task 1: Head 与 CI 取证

**Files:**
- Modify: `docs/superpowers/specs/2026-07-29-sooya-1-9-implementation-checklist.md`
- Create: `docs/superpowers/specs/2026-07-29-pr1-verification-record.md`

- [ ] 在分离目录检出 `bd2db8b08b0b28ebc76be13746c3ca97e13f4d06`，执行 `npm ci`、根与各 workspace 的 typecheck/build、`npm --workspace @sooya/server test`。
- [ ] 用 `gh run view 30435357087 --log-failed` 和 jobs API 区分 concurrency、人工取消、runner、超时或 E2E 卡死。
- [ ] 为 M-001～M-024 写入状态、证据、处理决定；M-003 的模拟运行时部分记为范围误判。

### Task 2: 语音情绪参数统一（M-004）

**Files:**
- Modify: `packages/server/src/core/replier.ts`
- Modify: `packages/server/src/routes/features.ts`
- Test: `packages/server/test/tts-expression.test.ts`

- [ ] 添加正式回复会将 `voice.emotions[emotion]` 的 `instructions` 与 `speed` 传给 provider 的失败测试。
- [ ] 运行该测试并确认失败原因是正式路径未传参数。
- [ ] 提取与试听共用的情绪参数解析函数，正式回复与试听均调用它；不支持参数由 provider 能力过滤。
- [ ] 重跑语音测试和服务端测试；提交 `fix(voice): apply emotion mapping to replies`。

### Task 3: Push 临时失败保留订阅（M-006）

**Files:**
- Modify: `packages/server/src/core/push.ts`
- Test: `packages/server/test/features-1-9.test.ts`

- [ ] 添加 500、503、fetch 抛错连续十次后订阅仍存在、404/410 删除、成功清零计数的失败测试。
- [ ] 运行测试并确认当前阈值删除行为失败。
- [ ] 删除临时错误的自动移除分支，仅保留 404/410 删除，并保留失败审计与计数。
- [ ] 重跑目标测试和服务端测试；提交 `fix(push): retain subscriptions after transient failures`。

### Task 4: 媒体令牌不进入 URL（M-010）

**Files:**
- Modify: `packages/web/src/lib/features.ts`
- Modify: `packages/web/src/components/FeatureAdminPage.tsx`
- Modify: `packages/web/src/components/GalleryPage.tsx`
- Test: `packages/web/src/lib/features.test.ts` 或现有 web 测试位置

- [ ] 添加 `adminMediaUrl` 不返回 `admin_token` 查询参数的失败测试。
- [ ] 将受保护媒体渲染改为认证 fetch 后的 Blob URL，并在 unmount/替换时 revoke；不得把 token 写入 URL、缓存或日志。
- [ ] 运行 web 单元测试与 typecheck；提交 `fix(media): keep admin token out of media URLs`。

### Task 5: 精确媒体引用（M-011）

**Files:**
- Modify: `packages/server/src/db/repos/media.repo.ts`
- Modify: `packages/server/src/db/migrations.ts`
- Test: `packages/server/test/features-1-9.test.ts`

- [ ] 先添加 `media_abc` 不匹配 `media_abcd`、结构化 `mediaId` 匹配、消息/贴纸/头像/世界数据均阻止删除的失败测试。
- [ ] 添加受迁移管理的 `media_references` 表或使用 SQLite JSON 精确路径查询；所有永久删除与孤立扫描共用同一引用判定。
- [ ] 运行迁移回滚、目标测试和服务端测试；提交 `fix(media): use exact media references`。

### Task 6: 记录与最终阶段

**Files:**
- Modify: `docs/superpowers/specs/2026-07-29-sooya-1-9-implementation-checklist.md`
- Modify: `docs/superpowers/specs/2026-07-29-pr1-verification-record.md`

- [ ] 每项在修复或核验后更新状态、命令、SHA、测试和外部阻塞。
- [ ] 只在新的完整 Actions run 真实 success 且真机证据具备时勾选最终验收；否则保持未勾选。
