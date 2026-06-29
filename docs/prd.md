# HVAC-X 3+3 Layout Optimizer

| Field | Value |
| --- | --- |
| Status | Active |
| Version | 2.0 |
| Last updated | 2026-06-29 |

## Objective

Optimize exactly three ceiling supplies and three ceiling returns in one room.
The product varies only each group’s spacing and offset along a directed
installation line, predicts a velocity-magnitude field, evaluates occupied-plane
performance, and produces a deterministic ranking and report.

This is an early-layout screening tool. It does not claim CFD validation and
does not predict temperature, pressure, comfort, energy, contaminants, or
transient behavior.

## Product flow

```text
Editor chat or structured API
  → Mastra HVAC agent
  → HVAC optimization workflow
  → candidate generation
  → topology rules
  → PiGINOT prediction
  → evaluation
  → velocity rules
  → ranking
  → report
```

The HVAC agent gathers missing input and reads Pascal scenes through MCP. It
must not calculate coordinates, rules, KPIs, scores, rankings, or report values.

## Fixed inputs and variables

Fixed inputs are:

- room bounds;
- one directed installation line for supplies and one for returns;
- one offset direction per line;
- terminal dimensions and flow directions;
- total balanced flow;
- minimum clearance;
- score weights;
- grid metadata;
- candidate limit.

Variables are supply spacing, supply offset, return spacing, and return offset.
For a line midpoint `m`, unit line direction `d`, unit offset direction `o`,
spacing `s`, and offset `q`, the three terminal centres are:

```text
anchor = m + q × o
centres = anchor + {-s, 0, +s} × d
```

All six terminals are independent model inputs. Candidate identity is a stable
hash of canonical terminal roles and coordinates.

## Candidate generation

The optimizer enumerates the Cartesian product of all four variable ranges,
removes duplicate coordinate sets, rejects room-boundary, edge-clearance, and
terminal-overlap violations, and preserves deterministic order. When more
candidates are valid than requested, it selects evenly distributed indices.
No random search is used.

PiGINOT accepts at most 25 candidates per batch. A candidate failure remains in
the run and does not stop other candidates. A run fails only for invalid input,
no valid candidate, no successful prediction, or a failed report.

## Evaluation

All KPIs use the velocity-magnitude plane at the configured occupied height:

```text
ACH = total_flow_m3s × 3600 / room_volume_m3
mean_velocity = mean(v)
max_velocity = max(v)
dead_zone_ratio = count(v < 0.10) / count(v)
air_sweep_coverage = count(0.10 <= v <= 0.30) / count(v)
uniformity = clamp(1 - std(v) / mean(v), 0, 1)
```

Uniformity is zero when mean velocity is zero. Rules are:

- `R-V1`: fail when mean velocity is above `0.30 m/s`;
- `R-V2`: warn when maximum velocity is above `0.30 m/s`;
- `R-V3`: penalize when dead-zone ratio is above `0.20`;
- `R-V4`: reward when air-sweep coverage is above `0.80`;
- `R-V5`: warn when uniformity is below `0.50`.

Default score weights are draft `0.30`, dead zone `0.30`, coverage `0.20`,
uniformity `0.10`, and practicality `0.10`. Ranking uses higher score, lower
dead-zone ratio, higher coverage, then lexicographically smaller candidate ID.
The Pareto set minimizes mean velocity and dead-zone ratio while maximizing
coverage.

## Required interfaces

The agent server provides chat plus structured routes for:

- start;
- status and ordered events;
- complete ranking;
- candidate metadata;
- raw Float32 field;
- occupied-plane JSON;
- Markdown or JSON report;
- cancellation;
- deletion.

The editor calls only the agent server. PiGINOT exposes
`POST /api/v1/hvac-inference-batch` through REST and the existing FastMCP mount.
PiGINOT returns model identity, grid metadata, per-candidate status, and
little-endian Float32 velocity magnitude encoded as base64. It returns no KPIs,
rules, scores, rankings, reports, or workflow state.

## Persistence

Mastra workflow snapshots use local LibSQL at
`${PASCAL_DATA_DIR}/agent-server/mastra.db`. Every successful candidate field
is retained at
`${PASCAL_DATA_DIR}/agent-server/hvac-runs/{runId}/fields/{candidateId}.f32`
with a JSON sidecar. Deletion is explicit and removes the entire run.

## Acceptance

- Both chat and structured API start the same committed workflow.
- Every candidate contains exactly three supplies and three returns.
- Changing terminal spacing changes the six-terminal input and prediction.
- Restarts can validate and reuse complete field artifacts.
- The editor contains no direct PiGINOT request.
- Deterministic schemas, coordinates, IDs, KPI boundaries, score, Pareto set,
  and tie-breaking have runnable tests.
- Recorded benchmarks meet 100 candidates under 10 seconds and 1,000 under 60
  seconds on named hardware.

The historical discovery interview remains under `docs/discovery/` and is not
an active product contract.
