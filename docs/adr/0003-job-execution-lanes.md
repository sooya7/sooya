# ADR 0003: Durable jobs use execution lanes

- Status: accepted
- Date: 2026-08-24

## Decision

Keep one Node process and one SQLite jobs table, but classify durable jobs into `critical`, `background`, `autonomous` and `maintenance` lanes. Each job also declares timeout, retryability, maximum attempts and cancellability.

## Why

QQ delivery and user-visible recovery must not wait behind Life, model enrichment, backfills or backups. Separate in-process lane pumps provide the isolation without introducing a distributed queue or service boundary.

## Consequences

- SQLite writes remain serialized by SQLite.
- A slow network task can still occupy its own lane, but cannot consume critical capacity.
- Job handlers receive an `AbortSignal`; cancellable timeouts stop cooperative handlers.
- `drain()` remains as a deterministic unit-test seam, while production uses lane pumps.
