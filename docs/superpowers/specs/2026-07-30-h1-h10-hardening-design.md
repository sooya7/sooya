# SOOYA H1–H10 Hardening Design

**Date:** 2026-07-30  
**Baseline:** `main` at `f4662c04e086b3e7b4e9ec207626b8dcdf826435`  
**Scope:** Review findings H1–H10 only

## Goal

Remove the confirmed security, message-consistency, reconnect, PWA-update, protected-media, and database-recovery risks from H1–H10 without expanding SOOYA's product scope or changing its single-user, single-conversation model.

Every behavior change is test-first, independently reviewable, and reversible. The work is divided into four risk slices so a failure in one subsystem does not block validation of the others.

## Review Triage

| Finding | Classification | Design response |
| --- | --- | --- |
| H1 message/event non-atomicity | Confirmed, wording overstated | Persist message and durable event in one database transaction. A focus resync currently limits the outage, but it does not close the crash window. |
| H2 withdraw race | Partially confirmed | Make withdrawal atomic and idempotent. The report's claim that withdrawal deletes the streaming assistant message is incorrect because user and assistant replies are separate messages. Do not add a global replier lock for this claim. |
| H3 reflective credentialed CORS | Confirmed | Default to same-origin/no CORS. Support an explicit allowlist only when configured. |
| H4 upstream error leakage | Confirmed | Return fixed user-facing failure text. Preserve detailed, redacted diagnostics only in `error_log` and server logs. |
| H5 WAL recovery data loss | Confirmed risk, unsafe suggested fix | Probe and salvage copies of the database/WAL set. Never delete production WAL/SHM as a recovery attempt. Use a verified backup only after copy-based recovery fails. |
| H6 reconnect stops after 100 messages | Confirmed | Page forward by message sequence until the server high-water mark is reached. |
| H7 shell assets not precached | Confirmed | Generate the service-worker precache list from the actual production build output. |
| H8 unsafe service-worker activation | Confirmed | Do not delete caches still needed by an uncontrolled page. Coordinate activation and a one-time controlled reload. |
| H9 protected-media download/viewer | Partially confirmed | Gallery items normally become Blob URLs before download, so the blanket failure claim is false. Remove unauthenticated raw-fetch fallbacks and fix admin-avatar/raw-path consumers. |
| H10 resend duplicates failed message | Confirmed | Replace the failed local row with the accepted server message after a successful resend. |

## Slice A: Security and Error Containment

### CORS

Production is same-origin through `echo.sooya.icu`, so the safe default is no cross-origin API access. The server will not reflect arbitrary origins and will not send credentialed CORS headers unless an origin appears in an explicit configuration allowlist.

Development continues to use Vite's same-origin proxy. Tests cover an absent Origin, the configured origin, an unlisted origin, and preflight behavior. No wildcard may be combined with credentials.

### Error boundaries

Fastify receives one global error handler. Expected application errors keep their explicit status and safe response. Unexpected errors receive a generated incident ID, a generic response, and a redacted internal log entry.

Chat bubbles never include provider response bodies, API-key fragments, internal URLs, filesystem paths, SQL text, or stack traces. Timeout, missing-provider, and generic-provider failures use stable localized messages. Detailed provider errors remain available to operators through the existing redacted error repository.

## Slice B: Durable Messages, Withdrawal, Reconnect, and Resend

### Atomic message plus event write

The durable event repository gains an append operation that can participate in an existing SQLite transaction. Message creation and its corresponding durable event are committed together. Live `EventEmitter` fan-out happens only after commit.

The transaction has two outcomes:

1. Both message and event exist, after which the event may be emitted live.
2. Neither exists.

Idempotent `clientMsgId` behavior remains unchanged. A duplicate request returns the existing message and does not append a duplicate `message.received` event.

Assistant lifecycle writes require the same invariant at stable visibility boundaries: the stored assistant shell and terminal `reply.completed`/`reply.failed` state must have a durable reconciliation path. High-frequency text deltas remain transient notifications; they are not individually coupled to message-part transactions.

### Atomic, idempotent withdrawal

Withdrawal runs its eligibility read, five-minute-window check, conditional metadata update, part replacement, and audit write in one SQLite transaction.

The transaction condition is: the target exists, is a user message, is still within the window, and has no `withdrawnAt`. Exactly one caller may transition it. A second concurrent caller receives the already-withdrawn representation instead of a primary-key failure or a second mutation.

The placeholder part uses an insertion strategy that cannot conflict on retry. Withdrawal does not touch the separate assistant reply row.

### Complete reconnect catch-up

The messages API returns:

- messages strictly after the requested message sequence;
- the current message high-water mark;
- whether another forward page remains.

The client repeatedly requests the next page using the highest sequence it actually merged. It stops only when it reaches the captured high-water mark, receives an empty page, is aborted, or hits a defensive finite page limit that triggers a full reload.

Only one resync loop runs at a time. A newer reload cancels an older loop. Pages are merged idempotently so retrying a page cannot duplicate messages.

### Resend replacement

Resend reuses the failed message content but creates a new `clientMsgId`. On success, the failed local message is removed and the accepted server message occupies its sorted sequence position. On failure, the original failed row remains visible and retryable. A resend never removes an already-persisted successful message.

## Slice C: PWA and Protected Media

### Build-derived precache

The production build emits a deterministic manifest of `index.html`, hashed JavaScript, hashed CSS, icons, and the web manifest. The final service-worker artifact is generated from that manifest, so a newly installed PWA can start offline before a second online visit.

Installation fails if a required shell asset cannot be cached. Optional assets do not make installation fail.

### Safe update lifecycle

An updated worker installs without immediately deleting the cache used by the active page. The page detects a waiting worker and requests activation at a controlled point. After `controllerchange`, the page performs at most one reload per update version.

Activation deletes caches only after the new shell is complete. Old hashed assets remain available during the handover, preventing a half-old/half-new page from receiving 404 responses.

### Unified protected-media operations

Protected media has one authenticated fetch path:

- header authentication;
- same-origin enforcement;
- `no-store`;
- expected Content-Type validation;
- Blob/Object URL creation;
- explicit revocation;
- safe download names;
- no token in URLs, logs, DOM attributes, history, cache keys, or share payload URLs.

Gallery thumbnails, admin avatars, viewer save/share, batch download, and raw-path fallbacks use this path. If a component already owns a tracked Blob URL, save/share reuses the tracked Blob rather than fetching again.

Viewer download/share errors remain visible and never fall back to an unauthenticated protected URL. Object URLs are revoked after replacement, unmount, completed download, and failed/aborted requests.

## Slice D: Copy-Based SQLite Recovery

Recovery never experiments on the production database set. On an unhealthy open:

1. Stop further writers before recovery proceeds.
2. Copy the main database, WAL, and SHM when present into a uniquely named recovery workspace.
3. Attempt normal SQLite open, WAL replay/checkpoint, and `integrity_check` on the copy.
4. If the coherent copy opens, promote a self-contained recovered snapshot atomically.
5. If the WAL copy is unusable, attempt a main-file-only salvage on another copy and explicitly record that WAL transactions could not be recovered.
6. If copy-based recovery fails, restore the newest checksum-valid, integrity-valid backup.
7. If no usable backup exists, fail closed and preserve all quarantine material. Do not silently start an empty permanent conversation database.

Every recovery result records the source, recovery tier, quarantined paths, integrity result, and whether WAL transactions may have been lost. Production startup does not claim readiness until migrations and integrity checks pass.

## Test Strategy

### Slice A

- Reject arbitrary credentialed origins.
- Accept same-origin and explicitly allowed development origins.
- Prove provider bodies containing token-like strings, internal endpoints, SQL, and paths never reach HTTP responses or chat parts.
- Prove detailed errors are redacted and retained in operator logs.

### Slice B

- Inject a failure between message/event operations and assert all-or-nothing storage.
- Send duplicate `clientMsgId` requests and assert one message and one durable event.
- Race two withdrawals and assert one transition, no 500, one placeholder, and stable final state.
- Catch up 250+ messages over multiple pages with no gaps or duplicates.
- Abort/restart resync and assert stale pages cannot overwrite newer state.
- Resend success replaces the failed row; resend failure preserves it.

### Slice C

- Inspect the built service worker and assert every required hashed asset is precached.
- Start a clean browser context offline immediately after installation and render the shell.
- Simulate an update while an old page is open and assert no hashed asset returns 404.
- Assert controller changes cause at most one reload.
- Assert thumbnails, avatars, save, share, viewer, and batch download send authorization headers and never expose tokens.
- Assert Blob URLs are revoked on replacement, unmount, abort, and completion.

### Slice D

- Recover a database with valid committed WAL content and retain the WAL-only rows.
- Handle corrupt WAL with an intact main database without modifying the original evidence set.
- Reject a corrupt main database and corrupt backup.
- Restore the newest valid backup only after copy-based recovery fails.
- Fail closed when neither salvage nor backup is valid.
- Assert recovery metadata and final integrity state.

## Delivery and Verification

Each slice receives:

1. A failing reproduction test.
2. The smallest production change that passes it.
3. Focused regression and abnormal-path tests.
4. Server/Web typecheck and production build as applicable.
5. Related complete test suites.
6. A separate commit.

After all four slices:

- run the complete server test suite;
- run the complete web unit suite;
- run the complete browser E2E suite on Linux;
- build and smoke-test the release container;
- verify upgrade and rollback against disposable data;
- update the existing verification record rather than creating a competing acceptance checklist.

Production deployment is a separate final operation. It requires a verified pre-upgrade backup, preserved shared configuration/data, health checks on `127.0.0.1:8788` and `echo.sooya.icu`, and an immediately available previous release.

## Explicit Non-Goals

- No simulation-world scheduler, offline catch-up engine, or daily-plan runtime.
- No multi-user/session redesign.
- No change to model providers or production API keys.
- No ANN/vector-database introduction.
- No implementation of medium/low findings outside dependencies strictly required by H1–H10.
- No direct mutation or deletion of production WAL/SHM during recovery experiments.
