# SOOYA 通用 MCP Host / Ombre Brain v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将 SOOYA 的长期记忆接入固定版本 Ombre Brain，同时把聊天侧能力实现为可管理多个 MCP Server 的 provider-neutral MCP Host，并保持现有回复中断、发布屏障、Life、Summary、Web Search 和媒体链路稳定。

**Architecture:** `McpManager` 管理多个独立 `McpConnection`，动态工具进入带 server namespace 的 `ToolRegistry`，再由 `ToolPolicy` 按 phase/risk 授权，`ToolCallRuntime` 在最终 streaming 前执行受限的 hidden tool rounds。Ombre 只通过 `OmbreMemoryBridge` 参与 wake/read/commit/dream 生命周期；旧 SQLite memory 在迁移观察窗口内保留为只读回滚源。生产 Ombre 独立部署为固定 `v2.7.6`（commit `6da5158b70d833626438a6fd5448f839c562d44b`）的 Docker 服务，不让 SOOYA 自动追踪 Ombre `main`。

**Tech Stack:** TypeScript, Fastify, Vitest, Zod, `@modelcontextprotocol/sdk@1.30.0`, Docker Compose, systemd timer deployment.

---

### Task 1: Tool and provider-neutral contracts

**Files:**
- Modify: `packages/server/src/providers/types.ts`
- Modify: `packages/server/src/agent/registry.ts`
- Create: `packages/server/src/agent/registry.test.ts`
- Create: `packages/server/src/providers/tool-types.test.ts`

- [ ] Add `ChatToolDefinition`, `ChatToolCall`, `ChatToolResult`, `ModelTurn`, `tools`, `toolChoice`, and `toolCalls` without exposing provider wire formats to core.
- [ ] Extend `ToolDescriptor` with `source`, `serverId`, `risk`, `phases`, and an optional `authorize` hook; reject duplicate canonical names and unknown tools.
- [ ] Test namespace collisions, schema metadata, risk/phase fields, and unknown-tool rejection.
- [ ] Run `npx vitest run packages/server/src/agent/registry.test.ts packages/server/src/providers/tool-types.test.ts`.

### Task 2: Provider tool protocol adapters

**Files:**
- Modify: `packages/server/src/providers/chat/openai.ts`
- Create: `packages/server/src/providers/chat/tool-protocol.test.ts`

- [ ] Add tool definitions/tool choice to OpenAI Chat, OpenAI-compatible, Responses, and Anthropic request mapping.
- [ ] Parse Chat Completions `tool_calls`, Responses `function_call`/`function_call_output`, and Anthropic `tool_use` into `ChatToolCall[]`.
- [ ] Serialize `ModelTurn` tool calls/results back into each provider's expected messages while preserving existing web search behavior.
- [ ] Return normal text and `supportsTools=false` fallback unchanged; keep intermediate tool rounds non-streaming.
- [ ] Test normal calls, parallel calls, malformed arguments, continuation, Responses hosted search coexistence, Anthropic tool use, and stream regression.
- [ ] Run the focused provider suite and `npm run typecheck -w @sooya/server`.

### Task 3: Policy, result safety, and runtime

**Files:**
- Create: `packages/server/src/agent/tool-policy.ts`
- Create: `packages/server/src/agent/tool-runtime.ts`
- Create: `packages/server/src/agent/tool-history.ts`
- Create: `packages/server/src/agent/tool-runtime.test.ts`

- [ ] Implement `reply`, `memory_commit`, `proactive`, and `maintenance` phase policies; allow only read tools in reply/proactive and writes only in lifecycle phases.
- [ ] Validate object arguments, schema limits, prototype-pollution keys, current registry membership, call/round/timeout budgets, and abort signals.
- [ ] Normalize string/structured tool results with 32 KiB per-result and 64 KiB total limits, explicit truncation markers, and safe error results.
- [ ] Execute same-round reads in parallel and writes sequentially; after budget exhaustion perform one tools-disabled final completion.
- [ ] Test abort, stale/unknown calls, parallel reads, sequential writes, limits, errors, and `supportsTools=false`.

### Task 4: Generic MCP manager and Ombre bridge

**Files:**
- Create: `packages/server/src/mcp/types.ts`
- Create: `packages/server/src/mcp/auth.ts`
- Create: `packages/server/src/mcp/result.ts`
- Create: `packages/server/src/mcp/connection.ts`
- Create: `packages/server/src/mcp/manager.ts`
- Create: `packages/server/src/mcp/health.ts`
- Create: `packages/server/src/mcp/tool-bridge.ts`
- Create: `packages/server/src/mcp/*.test.ts`
- Create: `packages/server/src/core/ombre-memory.ts`

- [ ] Add config-driven streamable HTTP connections using the official MCP SDK, independent auth per server, isolated reconnect/refresh, pagination-compatible tool discovery, and namespaced bridge descriptors.
- [ ] Ensure one server failure does not disable other servers or normal SOOYA replies; never log or expose tokens.
- [ ] Map Ombre v2.7.6 tools to read/write/maintenance risks and expose health/last-error/latency state.
- [ ] Implement wake breath, memory commit orchestration, durable receipt boundaries, and dream as lifecycle methods without implementing memory algorithms locally.
- [ ] Use fake MCP transports to test two-server isolation, duplicate remote names, auth, refresh, timeout, abort, `isError`, reconnect, and close.

### Task 5: Application wiring and staged memory cutover

**Files:**
- Modify: `packages/server/src/config/env.ts`
- Create: `config/mcp.json`
- Modify: `.env.example`
- Modify: `packages/server/src/core/context.ts`
- Modify: `packages/server/src/core/replier.ts`
- Modify: `packages/server/src/core/proactive.ts`
- Modify: `packages/server/src/core/jobs.ts`
- Modify: `packages/server/src/core/reply-coordinator.ts`
- Modify: `packages/server/src/app.ts`
- Modify: `packages/server/src/routes/health.ts`
- Modify: `packages/server/src/routes/admin.ts`
- Create: `scripts/migrate-sooya-memory-to-ombre.ts`
- Create: `packages/server/src/core/ombre-memory.test.ts`

- [ ] Assemble `ToolRegistry → McpManager → ToolPolicy → ToolCallRuntime → OmbreMemoryBridge` without changing ReplyCoordinator's state machine or publish barrier.
- [ ] Keep legacy recall behind an explicit backend flag for rollback, then make Ombre read the default; leave Summary/Life/persona/vision/sticker/world/capability context intact.
- [ ] Replace final-revision `memory.extract` enqueue with `ombre.memory_commit`, add durable receipt schema/queries and `ombre.dream`/refresh jobs, and prevent stale revisions from writing.
- [ ] Add MCP admin status/test/refresh endpoints, memory backend capability health, and redacted diagnostics.
- [ ] Add a read-only migration script with JSONL/manifest output, no embedding migration, and a `--dry-run` default; test idempotency and source trace metadata.

### Task 6: Deployment, backup boundary, and documentation

**Files:**
- Modify: `docker-compose.yml`
- Modify: `README.md`
- Modify: `docs/DEPLOYMENT.md`
- Modify: `docs/DATABASE.md`
- Create: `deploy/ombre/docker-compose.yml`
- Create: `deploy/ombre/.env.example`
- Create: `deploy/ombre/README.md`

- [ ] Keep the existing systemd SOOYA deployment path intact; add a separate pinned Ombre compose deployment with persistent buckets, localhost-only binding, static token auth, and no external proxy reuse.
- [ ] Make SOOYA MCP endpoint configurable for systemd (`127.0.0.1:18001/mcp`) and Docker network use without committing secrets.
- [ ] Document Ombre/SOOYA backup and restore boundaries, rollback flag, migration phases, health semantics, and pinned source commit.
- [ ] Validate compose configuration, build the pinned Ombre image, and run its health/MCP handshake before connecting SOOYA.

### Task 7: Verification and production rollout

**Files:**
- Modify: tests and docs only as needed by failed verification.

- [ ] Run typecheck, focused provider/runtime/MCP tests, existing memory/replier tests, full server tests, and production build.
- [ ] Run local fake-MCP end-to-end tests for interruption, stale revision, no leaked assistant message, and normal-chat degradation.
- [ ] Deploy Ombre to the authorized server with a preflight backup, verify its health, `tools/list`, bearer auth, persistent bucket, and dashboard loopback access.
- [ ] Publish only the verified SOOYA revision through the existing main/timer deployment path or preserve an explicit pending handoff if repository merge is the remaining external gate.
- [ ] Verify `/health/ready`, capabilities, deployed commit marker, updater logs, Ombre container health, and rollback artifacts; only then shut down the local computer as requested.
