# RFC: Central Mastra 3+3 HVAC Workflow

| Field | Value |
| --- | --- |
| Status | Accepted |
| Product requirement | [PRD](../prd.md) |
| Last updated | 2026-06-29 |

## Ownership

```text
apps/editor → apps/agent-server → piginot-backend
```

- The editor owns input and visualization only.
- The agent server owns validation, candidates, rules, occupied-plane
  extraction, KPIs, score, Pareto dominance, ranking, reports, events, and run
  lifecycle.
- PiGINOT owns independent six-terminal velocity-magnitude inference only.

## Workflow

`hvacOptimizationWorkflow` composes these committed workflows:

1. `candidateGenerationWorkflow`
2. `topologyRulesWorkflow`
3. `predictionWorkflow`
4. `evaluationWorkflow`
5. `velocityRulesWorkflow`
6. `rankingWorkflow`
7. `reportWorkflow`

Each child receives and returns an `OptimizationContext` containing the run ID,
candidate ID summaries, counts, status, and artifact root. Numerical fields
never enter workflow snapshots.

## PiGINOT batch contract

`POST /api/v1/hvac-inference-batch` accepts room and grid metadata plus one to
25 candidates. Each candidate has exactly six terminals. Each terminal has an
ID, `supply` or `return` role, centre, direction, and face velocity.

The response contains:

- model ID, version, and source;
- echoed grid shape, origin, and spacing;
- per-candidate success or failure;
- little-endian Float32 velocity magnitude as base64 for successful candidates.

The FastMCP server derives the same operation from the FastAPI route. Legacy
single and mesh inference routes remain available but are not used by the
optimizer. The legacy `collapse_diffusers()` path is not used by this contract.

## Run behavior

Prediction uses batches of 25. Only `429`, `502`, `503`, and `504` are retried,
twice, after one and two seconds. Candidate failures are retained. Validation
failure or zero successful predictions fails the run.

Before inference, an existing field is reused only when its byte length equals
`nx × ny × nz × 4`. Missing or invalid artifacts restart from the first batch
that contains them.

Events contain run ID, monotonic sequence, workflow ID, candidate counts,
status, optional error summary, and timestamp.

## Storage and API

Mastra uses
`${PASCAL_DATA_DIR}/agent-server/mastra.db`. Run metadata, fields, sidecars,
and reports use
`${PASCAL_DATA_DIR}/agent-server/hvac-runs/{runId}`.

The agent server exposes start, status, SSE events, ranking, candidate, raw
field, occupied plane, report, cancel, and delete routes under
`/api/v1/hvac/runs`. It also exposes the same run controls as HVAC-agent tools.

## Numerical evaluation

Fields are flattened in `(x, y, z)` C order. Occupied-plane extraction linearly
interpolates adjacent Z samples. KPI formulas, velocity rules, scoring,
dominance, and tie-breaking are defined in the PRD and run only in the agent
server.

## Deployment constraint

Production ranking requires a real independent 3+3 checkpoint adapter.
The checked-in nine-value averaged inlet/outlet checkpoint is incompatible and
must never be presented as a 3+3 model.
