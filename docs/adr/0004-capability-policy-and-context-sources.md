# ADR 0004: Resolve capabilities and context sources at boundaries

- Status: accepted
- Date: 2026-08-24

## Decision

Resolve raw deployment flags into a `CapabilityPolicy`, and collect optional context domains through `ContextSourcePipeline`. Domain code consumes the resolved policy and source outputs instead of reconstructing combinations of environment variables.

## Why

The operational question is not whether one flag is true; it is whether the complete capability path is available. Optional context such as Future, Relationship, Life and World must degrade independently so an unavailable enhancement never blocks a reply.

## Consequences

- Admin can inspect the effective capability combination.
- Adding a source requires one registration and one contract test.
- The pipeline owns isolation; ContextBuilder still owns order, dedupe and budget.
- Raw env flags remain for deployment compatibility.
