# ADR-001: Keep orchestration in Mastra and inference in PiGINOT

| Field | Value |
| --- | --- |
| Status | Accepted |
| Date | 2026-06-29 |

## Decision

`apps/agent-server` owns candidate generation, topology and velocity rules,
occupied-plane extraction, KPIs, scoring, Pareto dominance, ranking, reports,
events, persistence, retries, cancellation, and deletion.

`piginot-backend` is stateless. Its versioned batch operation accepts six
independent terminal inputs and returns only model identity, grid metadata,
candidate status, and raw velocity magnitude.

`apps/editor` calls only the agent server. Mastra uses REST for workflow
prediction; conversational diagnostics may use PiGINOT through MCP.

## Consequences

- Engineering values have one deterministic owner.
- PiGINOT cannot accumulate workflow or ranking behavior.
- Editor chat and structured triggers execute the same workflow.
- Legacy PiGINOT endpoints can remain during migration without becoming
  optimizer dependencies.
