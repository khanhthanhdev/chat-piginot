# HVAC-X Delivery Plan

| Field | Value |
| --- | --- |
| Status | Runtime hardening in progress |
| Product contract | [PRD](prd.md) |
| Technical contract | [RFC](technical/hvac-optimizer-rfc.md) |
| Last updated | 2026-06-29 |

## Locked decisions

- Exactly three ceiling supplies and three ceiling returns.
- Four variables: supply/return spacing and supply/return group offset.
- `apps/agent-server` owns all orchestration and engineering decisions.
- PiGINOT owns only independent-terminal model inference.
- The editor is a thin agent-server client.
- Fields remain on disk until explicit run deletion.
- Single-machine LibSQL and local artifacts are sufficient.

## Delivery sequence

1. Freeze the 3+3 request, field, event, ranking, and report contracts.
2. Add PiGINOT REST and MCP batch inference with the shared six-terminal
   fixture.
3. Commit the seven typed Mastra stage workflows and sequential orchestrator.
4. Add deterministic candidates, topology rules, KPI evaluation, velocity
   rules, Pareto ranking, and reports.
5. Add LibSQL snapshots, field artifacts, retries, cancellation, deletion, and
   resumable artifact checks.
6. Route editor chat and analysis through the central agent server.
7. Run unit, contract, recovery, browser, and performance verification.

Steps 1–6 are implemented. Unit, REST/FastMCP contract, editor conversion,
typecheck, build, and lint evidence is maintained with the code. Recovery,
browser smoke tests, recovery fault injection, and real-model verification
remain open.

## Mock orchestration benchmark

Run with `bun run --cwd apps/agent-server benchmark:hvac`.

| Hardware | Candidates | Elapsed | Run artifacts |
| --- | ---: | ---: | ---: |
| AMD Ryzen AI 7 H 350, Linux, 16 logical CPUs | 100 | 143 ms | 798,577 bytes |
| AMD Ryzen AI 7 H 350, Linux, 16 logical CPUs | 1,000 | 883 ms | 7,922,403 bytes |

Recorded 2026-06-29 with a `4 × 4 × 2` field and deterministic in-process mock
inference. These figures measure workflow, validation, evaluation, and artifact
I/O; they are not real-model latency or accuracy evidence.

## Verification gates

| Gate | Evidence |
| --- | --- |
| Contract | REST and MCP expose the same 3+3 operation |
| Determinism | Repeated input produces identical coordinates, IDs, and ranking |
| Isolation | PiGINOT returns no KPI, rule, score, ranking, or workflow data |
| Recovery | A restarted workflow skips complete validated `.f32` artifacts |
| Failure | Malformed fields, partial failures, retryable status codes, timeout, and cancellation are visible |
| Editor | No `/api/hvac-inference-mesh` request remains in editor code |
| Performance | 100 under 10 seconds and 1,000 under 60 seconds with hardware and storage recorded |

## Deferred

Authentication, distributed workers, external databases, automatic retention,
arbitrary terminal counts, and speculative search algorithms remain out of
scope until measured use requires them.

The real independent 3+3 adapter, physical validation, and real-model
performance are blocked on the user-provided backend. The analytic predictor is
an explicitly enabled development/test fixture and fails closed by default.
