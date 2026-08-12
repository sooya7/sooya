# SOOYA Admin 内容管理 + MCP + Ombre Implementation Plan

> **For agentic workers:** Execute this plan task-by-task in the isolated `codex/admin-content-ombre` worktree. Keep the existing MCP Host boundary; do not expose arbitrary MCP execution from Admin.

**Goal:** Align SOOYA Admin with the deployed Ombre-backed memory architecture while splitting content management into independently loaded MCP, memory, sticker, media, and chat-history surfaces with safe media reference handling.

**Architecture:** Extend the existing `ToolPhase`, `ToolPolicy`, `McpManager`, `ToolRegistry`, and `OmbreMemoryBridge` instead of replacing them. Add focused server services/routes for Ombre Admin reads, media usage, paged sticker queries, media lifecycle, and chat history; then replace the monolithic Admin content surface with route-aware React pages and shared toolbar/grid/drawer/status primitives. Preserve legacy memory as read-only rollback data when Ombre is active.

**Tech Stack:** TypeScript, Fastify, Zod, better-sqlite3, Vitest, React, Vite, Playwright, existing Admin CSS and deployment timer.

---

### Task 1: Establish lifecycle regression coverage

**Files:**
- Test: `packages/server/src/core/ombre-memory.test.ts`
- Test: `packages/server/src/core/reply-coordinator.test.ts` or the existing coordinator test covering batch wake
- Modify: `packages/server/src/core/ombre-memory.ts`, `packages/server/src/core/replier.ts`, `packages/server/src/core/jobs.ts`
- Modify: `packages/server/src/db/migrations.ts` and the Ombre receipt repository only if the test proves a schema gap

- [ ] Add failing tests for first-message wake in a batch, idempotent uncertain commit recovery, and persisted dream deduplication.
- [ ] Run the focused tests and confirm each fails for the missing lifecycle behavior.
- [ ] Implement the smallest lifecycle changes while preserving revision fencing and existing reply/proactive publication barriers.
- [ ] Run the focused tests and the existing lifecycle suite.
- [ ] Commit `fix: close Ombre memory lifecycle edges`.

### Task 2: Add Admin-safe MCP/Ombre backend contracts

**Files:**
- Modify: `packages/server/src/agent/registry.ts`, `packages/server/src/agent/tool-policy.ts`
- Create: `packages/server/src/core/ombre-admin.ts`
- Modify: `packages/server/src/routes/admin.ts` or split MCP/memory routes into focused route modules
- Modify: `packages/server/src/routes/health.ts`, `packages/server/src/app.ts`, `packages/server/src/config/env.ts`
- Test: `packages/server/src/routes/admin.test.ts`, `packages/server/src/core/ombre-admin.test.ts`, `packages/server/src/agent/tool-policy.test.ts`

- [ ] Add the `admin` phase and tests proving only Ombre read tools are authorized there.
- [ ] Add an Ombre Admin service that uses the existing registry/policy/manager, conservatively parses search blocks with raw fallback, detects catalog schema support, and sanitizes dashboard/config metadata.
- [ ] Expand MCP overview metadata without returning handlers, schemas by default, authorization headers, or secret values.
- [ ] Add `/api/admin/memory/status`, `/api/admin/memory/ombre/search`, `/api/admin/memory/ombre/catalog`, `/api/admin/memory/activity`, and `/api/admin/memory/legacy` with explicit `409 ombre_catalog_unavailable` behavior.
- [ ] Run focused server API/policy tests and commit `feat: add admin MCP and Ombre memory APIs`.

### Task 3: Add media usage safety and paged content APIs

**Files:**
- Create: `packages/server/src/core/media-usage.ts`
- Modify: `packages/server/src/db/repos/media.repo.ts`, `packages/server/src/routes/features.ts`, `packages/server/src/routes/admin.ts`
- Test: `packages/server/src/core/media-usage.test.ts`, `packages/server/src/routes/media-admin.test.ts`, `packages/server/src/routes/admin.test.ts`

- [ ] Add explicit SQL-backed usage aggregation for message parts, stickers, moments/proactive media, persona references, and other known media foreign keys.
- [ ] Extend media list/detail/usage/restore/trash/permanent-delete contracts with pagination, filters, usage counts, safe `409 media_in_use`, and no forced delete bypass.
- [ ] Extend sticker listing with search/status/source/emotion/enabled filters, facets, stable pagination, and no N+1 media queries.
- [ ] Complete chat-history query pagination/search/date/role/media filters and context retrieval without exposing internal tool history as ordinary chat messages.
- [ ] Run focused server tests and commit `feat: add safe admin content APIs`.

### Task 4: Split Admin shell and navigation

**Files:**
- Modify: `packages/web/src/components/AdminPanel.tsx`, `packages/web/src/AppShell.tsx`
- Create: `packages/web/src/components/admin/AdminSidebar.tsx`, `AdminPageHeader.tsx`, `ContentAdminPage.tsx`, `ContentSubnav.tsx`
- Create or modify: `packages/web/src/lib/admin.ts`, `packages/web/src/lib/adminDisplay.ts`
- Test: `packages/web/src/components/AdminPanel.test.tsx`, new navigation/content route tests
- Modify: `packages/web/src/components/AdminPanel.css`

- [ ] Add MCP as a first-level Admin route and convert `/admin/content` to `/memory`, `/stickers`, `/media`, and `/chat` subroutes with a default memory route.
- [ ] Keep existing admin auth, dirty-form protection, mobile navigation, notices, and top-level pages unchanged in behavior.
- [ ] Make content subpages load only their own data and preserve query parameters for filters/page/selected drawer item.
- [ ] Run focused Web tests and commit `feat: redesign admin content navigation`.

### Task 5: Implement MCP and Ombre memory views

**Files:**
- Create: `packages/web/src/components/admin/McpAdminPage.tsx`, `McpServerCard.tsx`, `McpToolTable.tsx`
- Create: `packages/web/src/components/admin/content/MemoryAdminView.tsx`, `OmbreMemoryView.tsx`, `LegacyMemoryView.tsx`
- Create: shared `AdminToolbar`, `AdminFilter`, `AdminStatusChip`, `AdminEmptyState`, `AdminSkeleton`, and drawer primitives under `packages/web/src/components/admin/`
- Modify: `packages/web/src/components/AdminPanel.css`
- Test: focused MCP/Ombre component tests

- [ ] Render server state, sanitized URL/config source, connection test/refresh busy/error states, tool risk/phase/authorization metadata, and no arbitrary tool execution controls.
- [ ] Render Ombre status/search/activity/catalog capability and Dashboard availability; show degraded state without breaking the page.
- [ ] Render legacy memories as a read-only rollback disclosure when Ombre is active, and preserve editable legacy view only for legacy backend.
- [ ] Hide old recall trace in Ombre mode and keep raw search fallback visible when parsing fails.
- [ ] Run Web tests and commit `feat: add MCP and Ombre memory admin views`.

### Task 6: Implement Sticker Gallery and Media Library

**Files:**
- Create: `packages/web/src/components/admin/content/StickerLibraryView.tsx`, `StickerCard.tsx`, `StickerDetailDrawer.tsx`, `StickerUploadDialog.tsx`
- Create: `packages/web/src/components/admin/content/MediaLibraryView.tsx`, `MediaCard.tsx`, `MediaDetailDrawer.tsx`, `MediaPreview.tsx`
- Modify: `packages/web/src/components/AdminPanel.css`
- Test: Sticker and Media component tests including mobile/drawer states

- [ ] Render paged lazy-loaded Sticker gallery with search/facets, analysis status, upload, batch analysis, drawer editing, and immediate pending state after force analysis.
- [ ] Render paged Media library with preview by kind, origin/date/size metadata, usage counts, detail references, trash/restore, and explicit in-use protection.
- [ ] Make thumbnail/preview failures local to the card and preserve list rendering.
- [ ] Add accessibility semantics for buttons, drawers/dialogs, Escape close, focus return, busy states, status, and alerts.
- [ ] Run Web component tests and commit `feat: redesign sticker and media management`.

### Task 7: Implement Chat History and event/activity wiring

**Files:**
- Create: `packages/web/src/components/admin/content/ChatHistoryView.tsx`
- Modify: server event publication and activity query paths as required by Task 2
- Test: Chat History server and Web tests
- Modify: `packages/web/src/components/AdminPanel.css`

- [ ] Add independently loaded chat history search/date/role/media filters, pagination, and context drawer.
- [ ] Ensure ordinary chat history excludes internal tool history while preserving existing redaction/withdrawal rules.
- [ ] Verify Ombre/MCP/sticker/media events expose only safe summaries and bounded recent activity.
- [ ] Run focused tests and commit `feat: separate admin chat history`.

### Task 8: Full verification and release integration

**Files:**
- Modify: relevant CI/release files only when a real failure demonstrates incompatibility
- Modify: docs/checklists only to record delivered contracts

- [ ] Run server and Web focused suites, typecheck, production build, E2E, release verification, and audit.
- [ ] Run final diff/scope review and confirm no secrets, arbitrary Admin MCP execution, direct Ombre storage reads, or unrelated changes.
- [ ] Push the feature branch and use the real GitHub Actions result as the CI gate; fix and repush any incompatibility.
- [ ] After CI is green, deploy through the existing timer-gated `main` workflow and verify deployed commit, updater logs, SOOYA health, MCP health, and real Ombre read/write safety checks.
- [ ] Preserve rollback backup and report residual risks before integration.
