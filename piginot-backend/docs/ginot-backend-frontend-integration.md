---
status: backend-implemented
createdAt: 2026-03-21T21:17:00+07:00
description: Backend-owned GINOT integration where the editor sends room geometry and semantic diffuser data, and the backend handles preprocessing, inference, and response shaping
priority: high
effort: large
---

# GINOT Backend-Frontend Integration Plan

## Goal

Move the GINOT integration boundary so the frontend does not build tensors, sample points,
normalize coordinates, or denormalize model outputs.

The editor should only:
- collect the selected analysis scope
- serialize room geometry to STL in memory
- send semantic diffuser data in world coordinates
- receive the backend response
- store and render that response

The backend should own everything else:
- mesh parsing
- bounds, center, and scale computation
- boundary sampling for `pc`
- interior sampling for `xyt`
- normalized `load` construction
- GINOT inference
- derived fields such as `speed`
- world-space response shaping
- optional viewer-ready grids or particle payloads

## Backend Implementation Notes

The backend implementation in this repository now follows that boundary:
- `app/api_mesh.py` accepts `multipart/form-data` on `POST /api/hvac-inference-mesh`
- `app/mesh_pipeline.py` parses the mesh, resolves quality presets, samples `pc` and `xyt`, and
  builds the internal 9-value `load`
- `app/response_builder.py` returns world-space metadata and bounds for direct viewer use
- `app/api.py` remains available as the legacy/debug tensor endpoint for `load + pc + xyt`

Current backend behavior:
- accepted mesh field name is `meshFile` and `mesh_file` remains accepted for compatibility
- `diffusers` is a JSON array and `options` / `context` are JSON objects
- at least one `supply` diffuser and one `return` diffuser are required
- at least one supply diffuser must define a non-zero `direction`
- if `airflowRate` is provided, the backend treats it as inlet speed magnitude in m/s and combines
  it with `direction`
- if `airflowRate` is omitted, the backend uses the `direction` vector magnitude directly as the
  inlet velocity magnitude
- quality presets currently map to:
  - `preview`: `boundaryCount=1000`, `interiorCount=1000`
  - `standard`: `boundaryCount=5000`, `interiorCount=5000`
  - `high`: `boundaryCount=20000`, `interiorCount=12000`

## Scope

### In scope

- one backend-first GINOT request path
- automatic scene-to-STL export from the editor
- world-space request and response contracts
- removal of runtime frontend GINOT preprocessing
- thin frontend mapping into existing viewer/node storage

### Out of scope for MVP

- browser-side voxelization from point cloud
- manual mesh upload as the primary editor workflow
- background job orchestration unless latency proves it necessary
- fake temperature, PMV, or comfort metrics derived from GINOT airflow output

## Key Decisions

### 1. Use one backend-owned inference path

The primary path should be a mesh endpoint such as `POST /api/hvac-inference-mesh`.

Mode A (`load + pc + xyt` from frontend) should be treated as legacy/debug only after the new path
ships. The production editor flow should not require frontend tensor construction.

### 2. Frontend sends semantic world data, not model tensors

Frontend should not send `load`, `pc`, or `xyt`.

Frontend should send:
- room mesh as STL blob
- diffuser descriptors in world coordinates
- optional quality/debug options

Recommended request contract:

```ts
type Vec3 = [number, number, number]

interface DiffuserInput {
  id: string
  kind: 'supply' | 'return'
  center: Vec3
  direction?: Vec3
  airflowRate?: number
}

interface GinotMeshRequest {
  meshFile: File | Blob
  diffusers: DiffuserInput[]
  options?: {
    quality?: 'preview' | 'standard' | 'high'
    boundaryCount?: number
    interiorCount?: number
    returnGrid3D?: boolean
  }
  context?: {
    projectId?: string
    levelId?: string
    zoneId?: string
  }
}
```

Rules:
- `boundaryCount` and `interiorCount` are debug overrides, not the normal product control
- backend decides how quality presets map to actual sample counts
- backend decides how to validate or collapse multiple diffusers into the current 9-value `load`

### 3. No manual upload in the normal editor experience

The editor already has STL export logic in `packages/editor/src/components/editor/export-manager.tsx`.
Reuse that path to create an in-memory STL blob for analysis instead of requiring the user to manage
files manually.

### 4. Backend returns world-space viewer payload

Backend should return world-space positions so the frontend does not denormalize anything.

MVP response fields:
- `positions`
- `velocities`
- `pressure`
- `speed`
- `bounds`
- `metadata`
- `inferenceId`
- `timestamp`
- `computeTimeMs`

Optional follow-up fields:
- `speedGrid3D`
- `pressureGrid3D`
- particle seed data

### 5. Keep request/response synchronous first

Stay with a single request/response cycle unless measured performance shows this is not viable.

Only introduce async jobs if:
- inference regularly exceeds the UI latency budget
- mesh upload size becomes a material bottleneck
- GPU scheduling or batching requires queued execution

## Current Frontend Responsibilities To Remove From Runtime Path

The current runtime GINOT pipeline is frontend-owned in:
- `packages/editor/src/lib/hvac/ginot-input-builder.ts`
- `packages/editor/src/lib/hvac/point-sampler.ts`
- `packages/editor/src/lib/hvac/normalization.ts`
- `packages/editor/src/hooks/use-hvac-analysis.ts`

These modules can remain temporarily for tests, fixtures, or fallback tooling, but they should stop
being part of the production GINOT request path.

## Step-by-Step Sub-Plans

### Sub-plan 1: Freeze the backend-first contract

Goal:
- define one unambiguous editor-to-backend contract before implementation moves

Tasks:
1. Rewrite `docs/ginot-backend-frontend-integration.md` so mesh mode is the primary integration path.
2. Replace the frontend tensor contract with `mesh + diffusers + options`.
3. Define backend validation rules:
   - STL first, OBJ later if needed
   - at least one supply and one return diffuser
   - world-space coordinates only
   - quality preset mapping
4. Define response semantics:
   - `positions` are world coordinates
   - `velocities` and `speed` are in m/s
   - `pressure` is in Pa
5. Define failure responses:
   - invalid mesh
   - missing or invalid diffusers
   - no interior points after sampling
   - inference timeout
   - backend unavailable

Deliverables:
- updated integration doc
- request/response examples
- error matrix

Acceptance criteria:
- there is one official request shape for the editor
- the contract requires no frontend normalization or denormalization

### Sub-plan 2: Build the backend preprocessing and inference pipeline

Goal:
- make backend the single owner of preprocessing and inference

Suggested backend modules:
- `backend/app/main.py`
- `backend/app/api.py`
- `backend/app/schemas.py`
- `backend/app/mesh_pipeline.py`
- `backend/app/inference.py`
- `backend/app/response_builder.py`
- `backend/tests/...`

Tasks:
1. Accept multipart requests with STL blob and diffuser JSON.
2. Parse mesh and compute bounds, center, and scale.
3. Sample boundary surface points and interior query points.
4. Convert diffuser world coordinates to normalized inlet/outlet positions.
5. Build internal `load`, `pc`, and `xyt` tensors.
6. Run GINOT inference and derive `speed`.
7. Return world-space positions plus metadata and timings.
8. Add structured validation, logging, and request tracing.
9. Add fixture-based tests for mesh parsing, sampling, inference, and response shape.

Acceptance criteria:
- backend runs end to end from STL plus world-space diffusers
- backend response is renderable without frontend denormalization
- regression fixtures can verify the pipeline consistently

### Sub-plan 3: Add automatic scene-to-STL export for analysis

Goal:
- remove manual mesh upload from the editor flow

Primary frontend files:
- `packages/editor/src/components/editor/export-manager.tsx`
- `packages/viewer/src/store/use-viewer.ts`

Tasks:
1. Extract STL generation into a reusable helper that returns `Blob` or `ArrayBuffer`.
2. Add export scope filtering so analysis uses only the selected level or zone geometry.
3. Keep download export working by reusing the same exporter helper.
4. Expose a frontend API such as `exportSceneToStlBlob(scope)` for the analysis hook.

Acceptance criteria:
- the editor can produce an in-memory STL blob for the selected room
- no user-managed upload step is required in the normal analysis path
- analysis export and download export share one code path

### Sub-plan 4: Replace the frontend GINOT request path with a thin client

Goal:
- remove runtime frontend GINOT preprocessing

Primary frontend files:
- `packages/editor/src/lib/hvac/ai-inference-client.ts`
- `packages/editor/src/hooks/use-hvac-analysis.ts`
- `packages/editor/src/lib/hvac/index.ts`

Tasks:
1. Add `callGinotMeshInference()` using multipart form data.
2. Build request payload from:
   - STL blob from the selected scope
   - diffuser descriptors from the scene
   - optional quality preset
3. Stop calling `buildGinotInput()`, `validateGinotInput()`, and `denormalizePoints()` in the
   runtime GINOT analysis path.
4. Remove or hide `ginotMode` after the backend-first path becomes the default.
5. Keep the legacy surrogate-model path isolated so its contract does not leak into GINOT.

Acceptance criteria:
- browser runtime no longer samples points or normalizes geometry for GINOT
- network request body contains only geometry, semantic boundary conditions, and options

### Sub-plan 5: Map backend response into existing viewer storage

Goal:
- keep frontend rendering thin while preserving current viewer integration

Primary frontend files:
- `packages/editor/src/hooks/use-hvac-analysis.ts`
- `packages/core/src/schema/nodes/heatmap.ts`
- `packages/viewer/src/components/renderers/heatmap/*`

Tasks:
1. Map backend arrays directly into `ginotPointCloud`.
2. Populate `speedField` and `pressureField` directly from the response.
3. If backend returns viewer-ready 3D fields, store them directly instead of rebuilding them on the
   client.
4. Keep renderer semantics honest:
   - GINOT airflow drives `speed` and `pressure`
   - no fake temperature or PMV values
5. Preserve loading, timeout, and error handling in the UI.

Acceptance criteria:
- response renders in the correct room position without extra transforms
- frontend does not reprocess geometry after receiving the response

### Sub-plan 6: Cleanup, deprecation, and rollout

Goal:
- finish the migration and make the backend-owned path the supported one

Tasks:
1. Mark the JSON tensor endpoint and frontend sampling utilities as legacy/debug only.
2. Remove dead exports from `packages/editor/src/lib/hvac/index.ts`.
3. Update docs so new work targets the mesh endpoint by default.
4. Add verification coverage for:
   - backend happy path with fixture mesh
   - frontend happy path from selected room
   - malformed mesh
   - missing diffuser
   - timeout and backend error handling
5. Decide after one release cycle whether to delete the old frontend GINOT preprocessing modules.

Acceptance criteria:
- backend-owned GINOT is the documented default
- there is no ambiguous duplicate official integration path

## Recommended Implementation Order

1. Lock the request and response contract.
2. Implement backend mesh endpoint with fixture-driven tests.
3. Refactor STL export to produce in-memory blobs.
4. Switch `use-hvac-analysis` to the new mesh client.
5. Verify viewer rendering and error handling.
6. Deprecate the old frontend GINOT preprocessing path.

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Selected-room STL export includes extra geometry | Add explicit level/zone export filtering before rollout |
| Backend cannot sample interior points from poor meshes | Validate mesh quality early and return actionable errors |
| Hidden frontend normalization logic survives the migration | Treat any runtime use of `buildGinotInput` or `denormalizePoints` as a migration bug |
| Large STL uploads make sync UX too slow | Start with quality presets and move to async only if measured latency requires it |
| Existing UI expects legacy temperature fields | Keep legacy surrogate analysis isolated; GINOT only owns airflow metrics |

## Verification Checklist

- [ ] Request payload contains STL plus semantic diffuser data only
- [ ] Backend returns world-space positions
- [ ] `use-hvac-analysis` no longer calls frontend GINOT sampling or normalization helpers at runtime
- [ ] GINOT point cloud aligns with selected room geometry
- [ ] Speed and pressure render correctly
- [ ] Invalid mesh and missing diffuser errors are visible in the UI
- [ ] Legacy surrogate analysis still works until intentionally retired
