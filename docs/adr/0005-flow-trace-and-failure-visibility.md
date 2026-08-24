# ADR 0005: Persist bounded flow traces for user-visible operations

- Status: accepted
- Date: 2026-08-24

## Decision

Persist recent metadata-only traces for user replies and proactive attempts. Each trace records stage names, status, timestamps and bounded safe details. Prompt text, message content, tokens and authorization material are excluded.

## Why

“It did not reply” is a cross-module failure. A durable stage trace makes the stuck boundary visible without requiring an APM service or a second database.

## Consequences

- Admin can distinguish ingress, model, persistence, queue and delivery failures.
- Traces are pruned to a bounded recent window.
- The trace is diagnostic; messages and channel delivery tables remain the product truth sources.
