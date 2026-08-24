# SOOYA Architecture Contract

This document is the short operational map for future changes. It describes ownership and user-visible invariants; it is not a framework migration plan.

## Domain ownership

| Domain | Owner | Durable truth |
| --- | --- | --- |
| Conversation | `core/reply-coordinator.ts`, `core/message-ingress.ts` | `messages`, `reply_batches` |
| QQ ingress/egress | `channels/qq/`, `routes/qq.ts` | `channel_events`, `channel_deliveries` |
| Proactive behavior | `core/proactive.ts`, `core/life/` | `proactive_attempts`, `life_*` |
| Future continuity | `core/future/` | `commitments` |
| Relationship continuity | `core/relationship/` | `relationship_threads` |
| Long-term memory | `core/memory.ts`, `core/ombre-memory.ts` | Ombre in production; legacy repo for fallback |
| Media | `media/`, `routes/features/media.routes.ts` | `media` plus managed filesystem |
| Operations | `core/jobs/`, `core/maintenance.ts`, `backup/` | `jobs`, `error_log`, backup manifests |
| Diagnostics | `core/flow-trace.ts`, `routes/flow-trace-admin.ts` | `flow_traces` |

## Dependency direction

```text
Routes / Channels
       ↓
Application services
       ↓
Domain logic
       ↓
Repositories / Providers
       ↓
SQLite / filesystem / network
```

The boundary check forbids route imports from domain internals in the wrong direction, provider/repository imports of routes or the app composition root, and web imports of server internals. Existing type-only domain references in repositories remain intentionally narrow and are not service-locator access.

## User-critical path

```text
QQ webhook → channel event → message ingress → reply batch → model → assistant message → qq.deliver → channel delivery
```

Every user reply and proactive attempt receives a bounded `flow_trace`. Admin can inspect recent traces and filter by message or proactive source:

- `GET /api/admin/debug/flow-traces`
- `GET /api/admin/debug/message-flow?messageId=...`
- `GET /api/admin/debug/proactive-flow?attemptId=...`
- `GET /api/admin/debug/flow-traces/:traceId`

Trace details are deliberately metadata-only and drop prompt/content/token-like fields.

## Background execution lanes

The shared SQLite job table is consumed through four independent in-process lanes:

| Lane | Purpose | Default |
| --- | --- | --- |
| `critical` | QQ delivery and visible recovery | concurrency 2, short timeout |
| `background` | memory, summary, future and relationship work | concurrency 1, retryable |
| `autonomous` | Life/proactive/world behavior | concurrency 1, cancellable |
| `maintenance` | backfills, cleanup, backup | concurrency 1, lowest priority |

Each registered job has a `JobDefinition` with lane, timeout, retry, attempt, timeout mode and cancellation metadata. `abort` is reserved for cooperative handlers that pass the signal to their IO; `observe` records a timeout without releasing a retry that could overlap an unknown late side effect. `JobDefinition.maxAttempts` supplies the default durable row value.

## Capability policy

Raw environment flags are resolved once into `CapabilityPolicy` in `config/capabilities.ts`. Application code uses the policy for proactive, continuity, memory, messaging and world decisions. The Admin capability inspector is available at `GET /api/admin/capabilities/policy`; the normal capabilities endpoint includes the same policy snapshot.

## Context pipeline

`ContextSourcePipeline` isolates optional Life, Future, Relationship and World sources. When configured, the pipeline is authoritative: a failed source produces no fragment and is not called again through a legacy fallback. ContextBuilder remains responsible for canonical ordering, deduplication and token budgeting.

## Life public contract

Production wiring exposes the `core/life/public-contract.ts` interface. Legacy Life and Life V2 both implement `tick`, `currentState`, `applyConversationSignal` and proactive candidate access. Callers must not branch on `LifeEngine` versus `LifeSimEngine`.

## Truth-source rules

- Chat messages: `messages`
- QQ delivery visibility: `channel_deliveries`
- Long-term memory: Ombre when enabled, legacy memory repo only as configured fallback
- Future commitments: `commitments`
- Relationship continuity: `relationship_threads`
- Current Life state: `life` / `life_v2` tables through the public contract
- Shared experiences: `episodes`
- Media: `media` plus the managed media directory
- Diagnostics: `flow_traces` and `error_log`
- Capability truth: `CapabilityPolicy`, including effective QQ proactive delivery and Ombre read/write state

## Change checklist

Before changing a domain, identify its truth source, capability policy, durable jobs, user contract and fault path. After changing it, run the focused contract/fault tests first, then the full workspace gates when the change is ready.
