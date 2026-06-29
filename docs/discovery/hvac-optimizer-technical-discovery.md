# HVAC-X Technical Discovery and Decision Log

| Field | Value |
| --- | --- |
| Status | Historical — superseded by manager PRD v1.0 |
| Discovery date | 2026-06-28 |
| Superseded | 2026-06-29 |
| Intended implementation team | 2–3 engineers plus a model owner |
| Current source of truth | [Canonical PRD](../prd.md) |

## Purpose

This document preserves the technical discovery performed against the
repository and the choices made against the earlier product scope. It is an
audit record, not a current implementation plan.

The manager later replaced that scope with the narrower velocity-only MVP in
[`docs/prd.md`](../prd.md). Current delivery is controlled by:

- [Canonical product requirements](../prd.md)
- [Technical RFC](../technical/hvac-optimizer-rfc.md)
- [Delivery master plan](../MASTER_PLAN.md)
- [Prediction boundary ADR](../adr/001-prediction-engine-boundary.md)
- [Coordinate convention ADR](../adr/002-layout-coordinate-convention.md)

## Supersession map

The following discovery choices no longer apply to the MVP:

| Historical choice | Current decision |
| --- | --- |
| Current PiGINOT checkpoint or retrained model | Deterministic analytical source/sink predictor |
| Independent 3+3 terminals | Fixed 4+4 terminals in centred 2×2 groups |
| Variable terminal area | Fixed terminal size |
| User-defined occupied volume | Fixed occupied plane at `z = 1.5 m` |
| Threshold-first ranking | PRD weighted score plus Pareto set |
| Seeded Latin hypercube | Deterministic bounded candidate generation; exact search implementation belongs to M2 |
| Durable Mastra workflow | Sequential in-process typed workflow |
| Baseline comparison and scene apply | Not required by the current PRD |
| Pressure visualization | Velocity magnitude only |
| External model-validation gate | Synthetic, golden, and invariance tests; no physical-validation claim |

Repository findings below remain useful only as evidence about the existing
checkpoint and editor integration. They do not change the current scope.

## Historical executive finding

The current trained GINOT model can visualize airflow velocity and pressure for one effective inlet and one effective outlet. It cannot support the PRD’s independent three-inlet/three-outlet layout optimization.

The current backend accepts multiple diffusers, but collapses them into one weighted inlet centre, one weighted outlet centre, and one inlet velocity before inference. Terminal spacing and area are therefore not represented faithfully. Symmetric layouts with different spacing may become identical model inputs.

The agreed strategy is split delivery:

1. Use the current checkpoint for an internal airflow/pressure visualization workflow and calculate only defensible field-derived airflow metrics.
2. Treat independent 3+3 layout optimization as a separate model-development track requiring a retrained multi-terminal model and held-out CFD validation.

Temperature, thermal comfort, PMV/PPD, and energy claims were removed.

## Repository evidence

### Current model contract

The model interface in `piginot-backend` is:

```text
load: [batch, 9]
  inlet centre:  3 normalized coordinates
  outlet centre: 3 normalized coordinates
  inlet velocity: 3 values in m/s

pc:  [batch, boundary points, 3]
xyt: [batch, query points, 3]

output: [batch, query points, 4]
  U, V, W, pressure
```

Evidence:

- `piginot-backend/docs/ginot-model-interface.md`
- `piginot-backend/app/models/ginot.py`
- `piginot-backend/app/mesh_pipeline.py`

### Multiple diffusers are averaged

`collapse_diffusers()`:

- Computes a weighted average of all supply centres.
- Computes a weighted average of all return centres.
- Computes one averaged inlet velocity vector.
- Preserves diffuser IDs only as response metadata.

Consequences:

- Individual terminal positions are lost.
- Terminal spacing is not a model feature.
- Terminal width, depth, face area, and collar size are not model features.
- Six physically different layouts may resolve to the same nine-value condition vector.
- The existing checkpoint cannot rank independent 3+3 layouts.

### Current outputs

The current response contains:

- Query positions.
- Velocity vectors.
- Pressure.
- Derived speed.
- Room bounds.
- Model source and inference metadata.
- Optional regular-grid metadata.

It does not contain:

- Temperature.
- Humidity.
- Mean radiant temperature.
- Heat loads.
- PMV/PPD.
- Comfort.
- Energy use.
- Contaminant concentration.
- Model confidence or out-of-domain status.

### Existing editor integration

`packages/editor/src/components/cfd-analysis/index.tsx` already:

- Builds an empty prismatic room STL from the room polygon and height.
- Reads duct-terminal nodes from the scene.
- Sends diffuser centres, directions, and `airSpeed`.
- Calls `POST /api/hvac-inference-mesh`.
- Renders velocity and pressure results.

Current limitations:

- Furniture, openings, and internal obstacles are excluded from the generated room mesh.
- `airflowRate` in the backend API is actually interpreted as speed in m/s.
- The editor calls the model backend directly.
- No optimization workflow exists.

### Model fallback

The backend defaults `GINOT_ALLOW_FALLBACK_MODEL` to true. When checkpoint loading fails, it silently uses `AnalyticFallbackGINOT`, which produces synthetic smooth fields and is explicitly not CFD-accurate.

Decision: fallback is permitted only in tests. Product and internal prototype runs must fail closed when the real checkpoint cannot load.

### Verification performed

The real checkpoint loaded successfully with fallback disabled:

```text
engine: torch
device: cpu
parameters: 2,516,613
source: saved_weights/ginot_trained_multicase.pth
```

Targeted backend verification:

```text
33 tests passed
```

Covered:

- Tensor inference.
- Mesh preprocessing.
- Diffuser collapsing.
- Mesh endpoint behavior.

The repository’s tests required `PYTHONPATH=.` when run through `uv`.

A synthetic CPU benchmark using 1,000 boundary points and 1,000 query points took approximately 0.22 seconds for one inference. This is not an end-to-end benchmark and provides no evidence of physical accuracy.

## Initial technical questions and repository answers

Before inspecting the repository, the following questions were raised.

| Question | Verified answer |
| --- | --- |
| Does a working model exist? | Yes. A checkpoint, loader, endpoint, and editor integration exist. |
| What are the exact inputs? | One effective inlet centre, one outlet centre, one inlet velocity, a boundary point cloud, and query points. |
| Can it represent six variable terminals? | No. Multiple terminals are averaged before inference. |
| What outputs exist? | Velocity and pressure fields only. |
| What training domain is supported? | Not documented in the repository. |
| How is out-of-domain input detected? | It is not detected. |
| What proves accuracy? | No model card or accuracy report exists in the repository. An external document was claimed but not provided. |
| What is inference latency? | A synthetic 1,000/1,000-point CPU run took about 0.22 seconds; production performance is unverified. |
| Does batch inference exist? | The model tensor supports a batch dimension, but no product batch endpoint or optimization workflow exists. |
| Is inference deterministic? | The model is placed in evaluation mode and mesh sampling uses a fixed seed; end-to-end repeatability still needs an acceptance test. |
| What failures exist? | Request validation, unsupported mesh, timeout, runtime/model failure, and rate limiting. |
| Are fields returned directly? | Yes. Arrays are returned inline in JSON, with optional regular-grid metadata. |
| Is PiGINOT production-ready? | It is a working research checkpoint with an unsafe analytic fallback and no checked-in model validation evidence. |
| Who owns the model contract? | The user stated a model owner and data exist; the owner is not named in project documents. |

## Decision interview

### 1. Product direction

**Question:** Which path should the verified technical plan commit to?

Options:

- Split delivery.
- Optimizer first.
- Current model only.

**Your choice:** Split delivery.

**Effect:** Ship honest airflow visualization first. Keep the independent 3+3 optimizer behind a model-development and validation gate.

### 2. First users

**Question:** Who may use the first airflow-visualization release?

Options:

- Internal prototype.
- Private HVAC pilot.
- Public product.

**Your choice:** Internal prototype.

**Effect:** The first release validates workflow and integration. It must display model limitations and must not be presented as final engineering approval.

### 3. Model capability and data

**Question:** What model-development capability exists beyond the repository?

Options:

- Owner and data available.
- Checkpoint only.
- Unknown.

**Your choice:** Owner and data available.

**Your note:** “Already have trained model, just infer and use.”

**Discovery result:** This is true only for current airflow/pressure inference. The checked-in architecture cannot produce thermal outputs or represent independent six-terminal layouts.

### 4. Initial optimizer target

**Question:** What should the future optimizer prove first?

Options:

- Airflow quality first.
- Full thermal scope.
- Geometry ranking only.

**Your initial choice:** Full thermal scope.

**Later revision:** Drop thermal claims and comfort entirely.

**Effect:** The implementation plan is airflow-only.

### 5. Thermal source

**Question:** What is the source of temperature and thermal-comfort predictions?

Options:

- Separate model exists.
- Extend/retrain GINOT.
- Drop thermal claims.

**Your choice:** Drop thermal claims.

**Effect:** Temperature uniformity, PMV/PPD, and thermal-comfort requirements must not appear in implementation acceptance criteria.

### 6. Comfort definition

**Question:** What does “full thermal scope” mean for acceptance?

Options:

- PMV/PPD standard.
- Temperature bands.
- Learned comfort score.

**Your choice:** Drop this.

**Effect:** No comfort score will be calculated or displayed.

### 7. Layout freedom

**Question:** How may the six terminals move and resize?

Options:

- Symmetric groups.
- Independent terminals.
- Approved templates.

**Your choice:** Independent terminals.

**Effect:** Each of three supplies and three returns requires its own position and area. The current nine-value model input is insufficient.

### 8. Multi-terminal model commitment

**Question:** What technical commitment is acceptable for independent six-terminal optimization?

Options:

- Retrain a multi-terminal model.
- Use one effective inlet/outlet pair.
- Use geometric heuristics.

**Your choice:** Retrain a multi-terminal model.

**Your note:** Visualize what the current model outputs and calculate only available metrics.

**Effect:** Current-model visualization and future-model optimization are separate release tracks.

### 9. Supply flow

**Question:** How should supply airflow be controlled while comparing layouts?

Options:

- Fixed total flow with equal split.
- Fixed total flow split by area.
- Independent flow variables.

**Your choice:** Fixed total flow with equal split.

**Effect:** Each supply receives one third of total volumetric flow. Face speed is derived from terminal area. Total flow remains constant for fair candidate comparison.

### 10. Placement domain

**Question:** Where may independent terminals move?

Options:

- Two allowed surface zones.
- Whole ceiling.
- Any room surface.

**Your choice:** Two allowed surface zones.

**Effect:** The user defines one planar supply zone and one planar return zone. Candidates inherit each zone’s mounting surface and orientation.

### 11. Derived metrics

**Question:** Which calculated metric set should the first release expose?

Options:

- Core airflow metrics.
- Raw fields only.
- Include weaker heuristics.

**Your choice:** Core airflow metrics.

**Agreed metrics:**

- Fraction of occupied-zone points inside the required speed band.
- Dead-zone fraction below the supplied minimum speed.
- High-speed fraction above the supplied maximum speed.
- Mean speed.
- P95 speed.
- Speed uniformity.

**Excluded metrics:**

- Temperature and comfort.
- Energy.
- Ventilation effectiveness.
- True short-circuiting.
- Any metric requiring contaminant or tracer transport.

### 12. Evaluation region

**Question:** How should the occupied zone be defined?

Options:

- User-defined volume.
- Derived room inset.
- Entire room.

**Your choice:** User-defined volume.

**Effect:** Metrics are calculated only from query points inside the supplied occupied-zone prism or box.

### 13. Batch evaluation

**Question:** Where should candidate batch evaluation run?

Options:

- Model-service batch.
- Agent orchestration calling the single endpoint repeatedly.
- Frontend loop.

**Your choice:** Model-service batch.

**Effect:** The room mesh and query points are prepared once, then reused across candidate inference.

### 14. Ranking

**Question:** How should airflow metrics select the best candidate?

Options:

- Thresholds, then coverage.
- Weighted score.
- Pareto set.

**Your choice:** Thresholds, then coverage.

**Effect:** Reject candidates violating dead-zone or high-speed limits. Rank survivors by speed-band coverage, then uniformity, then stable candidate ID. No arbitrary weighted 0–100 score is required.

### 15. Search strategy

**Question:** How should independent-terminal candidates be generated?

Options:

- Seeded Latin hypercube.
- Discrete Cartesian grid.
- Adaptive optimization.

**Your choice:** Seeded Latin hypercube.

**Effect:** Search remains deterministic while covering a high-dimensional position/area space within a bounded candidate budget.

### 16. Terminal sizing

**Question:** How should terminal size vary?

Options:

- Area with fixed aspect ratio.
- Independent width and depth.
- Fixed sizes.

**Your choice:** Area with fixed aspect ratio.

**Effect:** Each terminal varies area independently. Width and depth derive from the terminal’s fixed aspect ratio.

### 17. Multi-terminal validation data

**Question:** Do labeled CFD or experimental cases vary all six terminal positions and sizes independently?

Options:

- Yes, including held-out cases.
- Training cases only.
- No or unknown.

**Your choice:** Yes, including held-out cases.

**Effect:** Retraining and validation may proceed without first creating the entire dataset. The actual dataset and evidence have not yet been inspected.

### 18. Analytic fallback

**Question:** How should the fallback model be handled?

Options:

- Tests only.
- Visible demo mode.
- Silent fallback.

**Your choice:** Tests only.

**Effect:** Internal product runs fail when the trained checkpoint cannot load. Synthetic fields cannot enter ranking.

### 19. Metric thresholds

**Question:** Where should acceptable-speed and rejection thresholds come from?

Options:

- Required run inputs.
- Editable defaults.
- Hard-coded defaults.

**Your choice:** Required run inputs.

**Effect:** Every run must supply its acceptable speed band and maximum dead-zone/high-speed fractions. The system does not claim one universal standard.

### 20. Optimization ownership

**Question:** Which service should own candidate generation, metrics, and ranking?

Options:

- Python model service.
- Agent server.
- Split ownership.

**Your initial choice:** Agent server.

**Later revision:** Python computes compact raw metrics; the agent server owns candidate generation, acceptance thresholds, tie-breaking, and ranking.

**Effect:** Full numerical fields are not transferred for every candidate.

### 21. User interaction

**Question:** What is the primary internal-prototype interaction?

Options:

- Editor UI first.
- Agent first.
- Both immediately.

**Your choice:** Both immediately.

**Effect:** The editor and the agent must be thin clients over the same deterministic optimization workflow. The LLM must not implement a separate ranking path.

### 22. Accuracy gate

**Question:** What accuracy gate should the optimizer satisfy?

Options:

- Existing model criteria.
- Provisional screening criteria.
- No accuracy gate.

**Your choice:** Existing model criteria.

**Effect:** Optimization cannot be accepted until the existing criteria and held-out results are supplied and mapped to automated or repeatable checks.

### 23. Accuracy-criteria source

**Question:** Where can implementation obtain the existing criteria?

Options:

- External document.
- Model-team handoff.
- Not available.

**Your choice:** External document.

**Current status:** Blocking. No path or URL was supplied.

### 24. Workflow durability

**Question:** How durable must optimization jobs be?

Options:

- In-memory jobs.
- Mastra durable workflow.
- External queue.

**Your choice:** Mastra durable workflow.

**Effect:** Workflow state must survive agent-server restarts. The repository currently has no Mastra storage adapter. Current Mastra documentation supports persisted workflow snapshots with a storage adapter; file-backed LibSQL is the smallest suitable local deployment default.

### 25. Candidate budget

**Question:** What candidate budget should the first optimizer guarantee?

Options:

- 100 default and 1,000 maximum.
- 1,000 under three minutes.
- Time-budgeted search.

**Your choice:** 100 default and 1,000 maximum.

**Effect:** The under-three-minute target applies to 100 candidates on named reference hardware. Larger runs are asynchronous and receive no latency promise until benchmarked.

### 26. Discovery deliverable

**Question:** What should the interrogation ultimately produce?

Options:

- Verified document set.
- Implementation plan only.
- Documents and implementation plan.

**Your choice:** Implementation plan only.

**Effect:** The next planning artifact should specify implementation work. Product-document rewriting is not part of that request.

### 27. Team shape

**Question:** What team executes the first release?

Options:

- 2–3 engineers plus model owner.
- One full-stack engineer.
- Dedicated frontend/backend/ML teams.

**Your choice:** 2–3 engineers plus model owner.

**Effect:** Model work and application work may proceed in parallel behind a frozen contract.

### 28. Deployment

**Question:** Where will inference and optimization run?

Options:

- Shared GPU service.
- Local developer machines.
- Both.

**Your choice:** Local developer machines.

**Effect:** CPU is the required baseline. Performance results must record CPU, memory, OS, model version, sample counts, and candidate count.

### 29. Metric execution location

**Question:** Where should occupied-zone metrics be computed?

Options:

- Python computes metrics and TypeScript ranks.
- Agent server computes everything.
- Python computes and ranks everything.

**Your initial choice:** Agent server computes everything.

**Discovered consequence:** At 5,000 query points, 1,000 candidates produce roughly 80 MB of raw float32 `U,V,W,p` data before JSON overhead. Transferring all fields to TypeScript conflicts with the 1,000-candidate maximum.

**Revised choice:** Python computes metrics; TypeScript ranks.

### 30. Room fidelity

**Question:** What geometry must the first optimizer support?

Options:

- Empty room prism.
- Room with obstacles.
- Arbitrary uploaded mesh.

**Your choice:** Empty room prism.

**Effect:** Use room polygon, floor elevation, and ceiling height. Furniture, openings, and obstacles remain out of scope.

### 31. Applying a result

**Question:** What happens to the Pascal scene after ranking?

Options:

- Preview, then explicit apply.
- Automatically apply the best candidate.
- Report only.

**Your choice:** Preview, then explicit apply.

**Effect:** Optimization never mutates the scene automatically. Applying a selected candidate updates the existing six terminal nodes only after user confirmation.

### 32. Field payload tradeoff

**Question:** Which constraint should yield: metric location, candidate count, or transport complexity?

Options:

- Python computes metrics.
- Cap at 100 candidates.
- Build a large binary field pipeline.

**Your choice:** Python computes metrics.

**Effect:** The model service returns compact candidate metrics for all candidates and full field data only for the baseline and requested top candidates.

### 33. Baseline

**Question:** How should optimization compare with the existing design?

Options:

- Require the current layout.
- No baseline.
- Optional baseline.

**Your choice:** Require the current layout.

**Effect:** A run requires an existing valid 3+3 layout. A candidate is recommended only when it passes thresholds and improves speed-band coverage over the baseline.

### 34. Pressure

**Question:** How should predicted pressure be used?

Options:

- Visualization only.
- Ranking metric.
- Hidden.

**Your choice:** Visualization only.

**Effect:** Pressure may be rendered and reported, but cannot affect acceptance or ranking without a separately validated engineering definition.

## Historical consolidated technical direction

### Track A — current-model visualization

- Internal prototype only.
- Real checkpoint required; analytic fallback disabled.
- Empty prismatic room.
- Velocity and pressure visualization.
- Core occupied-zone airflow metrics only.
- Pressure excluded from ranking.
- No thermal, comfort, energy, or regulatory claims.

The product behavior for multiple diffusers under the current averaged model remains unresolved. It must either:

1. Restrict current-model visualization to one supply and one return, or
2. Display an explicit “effective averaged inlet/outlet” warning and disable layout comparison.

It must not imply that the current checkpoint resolves six independent terminals.

### Track B — independent 3+3 optimizer

- Retrained model with six independently represented terminal conditions.
- Three supply and three return terminals.
- Independent positions inside two user-defined planar zones.
- Independent area with fixed aspect ratio.
- Fixed total supply flow split equally across supplies.
- Empty prismatic room.
- User-defined occupied volume and required thresholds.
- Seeded Latin-hypercube candidate generation.
- Required current-layout baseline.
- Python batch inference and raw metric extraction.
- Agent-server feasibility gates and deterministic ranking.
- Default 100 candidates; maximum 1,000.
- Durable Mastra workflow.
- Editor and agent use the same workflow.
- Preview top candidates; apply only after confirmation.
- Model validation evidence required before optimization claims.

## Historical proposed service responsibility

| Component | Responsibility |
| --- | --- |
| Editor | Collect zones, occupied volume, total flow, search bounds, thresholds, and candidate budget; display progress, fields, metrics, and comparison; request explicit apply |
| Agent | Gather the same structured inputs conversationally; invoke the same workflow; explain existing results without inventing values |
| Agent server | Validate product inputs, read scene data, generate deterministic candidates, enforce geometry constraints, orchestrate batches, apply thresholds, rank, persist workflow state, and apply a confirmed candidate |
| PiGINOT model service | Build/reuse room samples, execute batch inference, reject unsupported model inputs, compute compact raw airflow metrics, and return/store requested field results |
| Pascal MCP | Read the current room and six terminal nodes; apply confirmed terminal patches |
| Model owner | Provide the multi-terminal checkpoint, contract, supported domain, model version, held-out validation evidence, and acceptance criteria |

## Historical future model contract

The retrained model must represent each terminal independently. At minimum, each of six terminal conditions needs:

- Normalized centre.
- Unit flow direction.
- Face area.
- Volumetric flow with a documented sign convention.
- Supply/return role, either explicit or fixed by canonical slot.

The room boundary point cloud and shared query points remain model inputs. Candidate order must be canonical so permuting identical supply terminals does not change predictions.

The exact tensor shape and encoder design belong to the model owner and must be frozen before application implementation depends on them.

## Historical blockers

### Blocking artifact

The external model-validation document is still missing.

Required contents:

- Dataset identity and ownership.
- Training/validation/test split.
- Evidence that held-out cases vary all six terminal positions and sizes.
- Supported room and boundary-condition ranges.
- Field-error metrics.
- Ranking or metric-error acceptance thresholds.
- Results for the exact checkpoint intended for integration.
- Model version or checkpoint hash.

No optimization implementation should be accepted until this artifact is reviewed.

### Decisions not yet made

1. Exact path or URL of the external model-validation document.
2. Whether Track A permits averaged multi-diffuser visualization or requires one supply and one return.
3. Exact multi-terminal model request/response tensor contract.
4. Exact reference local machine for the 100-candidate performance target.
5. Exact speed-uniformity formula and deterministic ranking tie-break order.
6. Exact Mastra storage location, retention period, and cleanup policy.

## Historically invalidated assumptions

The implementation plan must not preserve these assumptions:

- The current model supports independent 3+3 terminal placement.
- Terminal area currently affects inference.
- Current model output includes temperature or comfort.
- Energy can be inferred from the current response.
- Multiple diffusers remain distinct through preprocessing.
- Existing tests establish physical accuracy.
- The analytic fallback is acceptable for recommendations.
- All candidate fields can be transferred as JSON at a 1,000-candidate scale.
- An LLM should independently implement optimization or ranking logic.
