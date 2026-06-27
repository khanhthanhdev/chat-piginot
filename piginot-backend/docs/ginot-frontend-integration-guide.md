---
status: active
createdAt: 2026-03-22T00:00:00+07:00
description: Frontend integration guide for the current GINOT CFD backend
---

# GINOT Frontend Integration Guide

This document is the frontend-owned integration guide for the current backend in this repository.

Use it when wiring the editor or viewer to the backend API. It reflects the current implementation,
not the older planning documents.

## Integration Rules

The frontend should:
- export the selected room or zone geometry to an in-memory STL `Blob`
- collect diffuser metadata in world coordinates
- call the mesh endpoint
- store and render the returned world-space payload

The frontend should not:
- build `load`, `pc`, or `xyt`
- normalize or denormalize coordinates
- sample boundary or interior points
- derive the 9-value model load vector
- use the legacy JSON tensor endpoint in production

## Backend Endpoints

### Production endpoint

`POST /api/hvac-inference-mesh`

Use this for all normal editor and viewer flows.

### Health endpoint

`GET /health`

Use this for service readiness checks, local environment debugging, or admin diagnostics.

### Legacy/debug endpoint

`POST /api/hvac-inference`

This endpoint accepts prebuilt tensors and is only for fixtures, debugging, or controlled internal
tools. Do not build production frontend flows on top of it.

## Request Contract

### Content type

Send `multipart/form-data`.

Do not set the `Content-Type` header manually when using `fetch` with `FormData`. Let the browser
set the multipart boundary.

### Multipart fields

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `meshFile` | file | Yes | STL is the recommended frontend output format. `mesh_file` is still accepted for compatibility, but new code should use `meshFile`. |
| `diffusers` | JSON string | Yes | Array of world-space supply/return diffusers. |
| `options` | JSON string | No | Sampling quality and optional debug overrides. |
| `context` | JSON string | No | Project, level, or zone metadata for tracing. |

### TypeScript request types

```ts
export type Vec3 = [number, number, number]

export interface DiffuserInput {
  id: string
  kind: 'supply' | 'return'
  center: Vec3
  direction?: Vec3
  airflowRate?: number
}

export interface MeshInferenceOptions {
  quality?: 'preview' | 'standard' | 'high'
  boundaryCount?: number
  interiorCount?: number
  returnGrid3D?: boolean
}

export interface MeshInferenceContext {
  projectId?: string
  levelId?: string
  zoneId?: string
}

export interface MeshInferenceRequest {
  meshFile: Blob
  meshFilename?: string
  diffusers: DiffuserInput[]
  options?: MeshInferenceOptions
  context?: MeshInferenceContext
}
```

### Diffuser rules

The backend currently requires:
- at least one `supply` diffuser
- at least one `return` diffuser
- at least one supply diffuser with a non-zero `direction`
- unique diffuser IDs
- `center` and `direction` values to contain 3 finite numbers

Velocity handling:
- if `airflowRate` is provided, the backend treats it as the supply speed magnitude in m/s
- if `airflowRate` is omitted, the backend uses the `direction` vector magnitude directly

Frontend recommendation:
- always send `airflowRate` explicitly when your product has a real airflow or target speed input
- treat `direction` as orientation, not as a hidden magnitude channel, unless the UI truly models it

### Quality presets

| Quality | Boundary Samples | Interior Samples | Use |
|---------|------------------|------------------|-----|
| `preview` | 1000 | 1000 | Fast first result while editing |
| `standard` | 5000 | 5000 | Default user-facing result |
| `high` | 20000 | 12000 | Slower, more detailed review |

Frontend recommendation:
- expose `quality`
- do not expose `boundaryCount` and `interiorCount` in the normal product UI
- keep count overrides for debug or admin tools only

## Response Contract

### TypeScript response types

```ts
export interface Bounds {
  min: Vec3
  max: Vec3
}

export interface ResponseMetadata {
  inletCenter: Vec3
  outletCenter: Vec3
  inletVelocity: Vec3
  boundaryCount?: number
  interiorCount?: number
  quality?: string
  supplyDiffuserIds?: string[]
  returnDiffuserIds?: string[]
  modelSource?: string
}

export interface GinotInferenceResponse {
  positions: Vec3[]
  velocities: Vec3[]
  pressure: number[]
  speed: number[]
  bounds: Bounds
  metadata: ResponseMetadata
  inferenceId: string
  timestamp: number
  computeTimeMs: number
}
```

### Response semantics

The backend returns:
- `positions` in world space
- `velocities` in m/s
- `pressure` in Pa
- `speed` in m/s
- `bounds` in world space

Frontend implication:
- render the response directly
- do not denormalize anything
- store the payload as viewer-ready analysis data

## Recommended Frontend Structure

Keep the client thin and split responsibilities clearly:

| Layer | Responsibility |
|------|----------------|
| `analysis/export` | Produce STL `Blob` from selected scene scope |
| `analysis/contracts` | Shared TypeScript request and response types |
| `analysis/client` | Build `FormData`, call backend, normalize transport errors |
| `analysis/service` | Coordinate export, diffuser extraction, request lifecycle, retries |
| `viewer/store` | Persist response payload and expose render state |
| `viewer/render` | Render vectors, particles, streamlines, or heatmaps from backend output |

Recommended file split:

```ts
src/lib/ginot/contracts.ts
src/lib/ginot/client.ts
src/lib/ginot/service.ts
src/lib/ginot/errors.ts
src/lib/ginot/to-viewer-payload.ts
```

## Reference Client

```ts
import type {
  GinotInferenceResponse,
  MeshInferenceRequest,
} from './contracts'

export class GinotApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly requestId?: string,
  ) {
    super(message)
  }
}

export async function runMeshInference(
  apiBaseUrl: string,
  request: MeshInferenceRequest,
  signal?: AbortSignal,
): Promise<GinotInferenceResponse> {
  const formData = new FormData()
  formData.append(
    'meshFile',
    request.meshFile,
    request.meshFilename ?? 'analysis-room.stl',
  )
  formData.append('diffusers', JSON.stringify(request.diffusers))

  if (request.options) {
    formData.append('options', JSON.stringify(request.options))
  }

  if (request.context) {
    formData.append('context', JSON.stringify(request.context))
  }

  const response = await fetch(`${apiBaseUrl}/api/hvac-inference-mesh`, {
    method: 'POST',
    body: formData,
    signal,
    headers: {
      'X-Request-ID': crypto.randomUUID(),
    },
  })

  const requestId = response.headers.get('X-Request-ID') ?? undefined
  const payload = await response.json().catch(() => null)

  if (!response.ok) {
    const detail =
      payload && typeof payload.detail === 'string'
        ? payload.detail
        : 'Mesh inference failed'

    throw new GinotApiError(detail, response.status, requestId)
  }

  return payload as GinotInferenceResponse
}
```

## Recommended Request Flow

1. Resolve the analysis scope in the editor.
2. Export that scope to STL in memory.
3. Collect diffuser descriptors in world space.
4. Call `POST /api/hvac-inference-mesh` with `quality`.
5. Store the full backend response plus the request context.
6. Render directly from `positions`, `velocities`, `pressure`, and `speed`.

Recommended UX:
- default to `standard`
- optionally offer `preview` for fast iteration
- use `AbortController` so a newer analysis request cancels the older one
- disable duplicate submissions while one request is running for the same scope
- preserve the last successful result while a new request is loading

## Error Handling

The backend returns a JSON body with a string `detail` for most failures.

### Status handling

| Status | Meaning | Frontend behavior |
|--------|---------|-------------------|
| `400` | Invalid mesh or diffuser payload | Show backend message directly to the user or debug panel |
| `504` | Inference exceeded configured timeout | Suggest retry with `preview` or `standard` quality |
| `500` | Backend runtime failure | Show generic failure and allow retry |
| network error | Service unavailable or CORS issue | Show connectivity message and keep last successful result |

Best practice:
- capture `X-Request-ID` from the response header
- attach it to logs, error reports, and support diagnostics
- keep raw backend `detail` for internal troubleshooting

## Frontend Do and Don't

Do:
- send STL, not ad hoc point clouds
- keep all coordinates in world space on the frontend side
- use one shared API client for all CFD requests
- validate basic diffuser completeness before network submission
- treat the backend response as the source of truth for rendered results

Don't:
- hardcode your own normalization logic
- denormalize `positions`
- rebuild the old tensor pipeline in the browser
- expose raw point-count overrides to normal end users
- use the legacy `/api/hvac-inference` endpoint as the main UI path

## Minimal Pre-submit Validation

Frontend validation should stay light. Validate only what improves UX before the request:
- at least one supply diffuser exists
- at least one return diffuser exists
- every diffuser has a stable `id`
- every diffuser center has 3 numeric values
- at least one supply diffuser has a direction
- a mesh blob was generated successfully

Do not duplicate backend mesh parsing or sampling validation in the client.

## Rendering Notes

Because the payload is already world-space:
- particle seeds, glyphs, vectors, and scalar overlays can be derived directly from `positions`
- `bounds` can drive camera framing, grid extents, and culling
- `metadata.inletCenter`, `metadata.outletCenter`, and `metadata.inletVelocity` can drive legends
  and annotation layers

Recommended storage shape:

```ts
export interface StoredGinotResult {
  request: {
    quality: 'preview' | 'standard' | 'high'
    context?: MeshInferenceContext
    diffuserIds: string[]
  }
  response: GinotInferenceResponse
  receivedAt: number
}
```

## Test Checklist

Before shipping the frontend integration, verify:
- STL export matches the selected analysis scope
- diffuser centers and directions are world-space and not local-space
- `preview`, `standard`, and `high` all work
- request cancellation does not overwrite newer results
- backend `400` messages surface cleanly in the UI
- large results still render without blocking the main interaction loop
- persisted analysis results can be reloaded without recomputing

## Current Backend Defaults

The backend currently defaults to:
- `MAX_BOUNDARY_POINTS=100000`
- `MAX_INTERIOR_POINTS=50000`
- `INFERENCE_TIMEOUT_SECONDS=30`

Do not rely on these values in the frontend for core logic. They are backend deployment concerns.
Use them only as guidance for UX and fallback messaging.
