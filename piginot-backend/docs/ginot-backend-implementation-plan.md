# GINOT Backend Implementation Plan

Backend-first architecture for GINOT CFD simulation. All computation is owned by the Python backend;
the frontend is pure visualization.

---

## Architecture Decision

**Current State:** Backend owns all preprocessing and inference via `POST /api/hvac-inference-mesh`.

**Frontend Responsibilities:**
- 3D editor UI (diffuser placement, room selection)
- Automatic STL export of selected room geometry
- Thin API client (send mesh + diffusers, receive world-space results)
- Three.js visualization (point cloud rendering, heatmaps)

**Backend Responsibilities:**
- Mesh parsing and validation (STL, OBJ)
- Bounds, center, and scale computation
- Boundary surface sampling (`pc`)
- Interior volume sampling (`xyt`)
- Diffuser collapsing and normalized `load` construction
- GINOT model inference
- Derived `speed` calculation
- World-space response shaping

---

## Primary Endpoint

### `POST /api/hvac-inference-mesh`

Accepts `multipart/form-data` with:

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `meshFile` | file | Yes | STL (primary), OBJ also supported |
| `diffusers` | JSON array | Yes | Supply/return diffusers in world coordinates |
| `options` | JSON object | No | Quality preset and debug overrides |
| `context` | JSON object | No | Project/level/zone identifiers |

Response returns world-space positions, velocities, pressure, speed, bounds, and metadata.
No frontend denormalization required.

See `docs/ginot-backend-api-specification.md` for the full contract.

### `POST /api/hvac-inference` (Legacy/Debug)

Accepts prebuilt `load`, `pc`, and `xyt` tensors as JSON. Use only for fixture testing or
controlled experiments. Production frontend code should call the mesh endpoint.

---

## Implementation Status

### Phase 1: Backend API Setup — Complete

- FastAPI application with CORS and rate limiting
- Pydantic schemas for request/response validation
- Input validators for both tensor and mesh endpoints
- GINOT model loading with analytic fallback
- Request ID middleware and structured logging

### Phase 2: Mesh-Based Endpoint — Complete

- Multipart request parsing for STL + diffuser JSON
- Mesh loading (binary STL, ASCII STL, OBJ)
- Bounds, center, and scale computation
- Boundary surface sampling and interior volume sampling (rejection)
- Diffuser collapsing into 9-value `load` vector
- World-space response positions (no frontend denormalization)

### Phase 3: Testing and Observability — Complete

- Fixture-based tests for mesh parsing, normalization, and sampling
- Diffuser collapsing tests (single, multiple, edge cases)
- Quality preset resolution tests
- Mesh inference endpoint integration tests
- Legacy tensor endpoint tests
- Structured logging with request IDs

### Phase 4: Frontend Integration — Pending (frontend repo)

- Automatic scene-to-STL export for analysis
- Thin client calling `POST /api/hvac-inference-mesh`
- Response mapping into existing viewer storage
- Deprecation of frontend tensor preprocessing

### Phase 5: Production Deployment — Pending

- Containerize with Docker (Dockerfile exists)
- GPU-enabled hosting
- Environment variable configuration
- Monitoring and auto-scaling

---

## Key Technical Decisions

### 1. Normalization Strategy

**Decision:** Backend computes normalization from the uploaded mesh.

The backend derives `center` and `scale` from mesh bounds and applies them internally.
The frontend never normalizes or denormalizes.

### 2. Velocity Normalization

**Decision:** Velocity in load vector is NOT normalized.

- Indices 0–5 (inlet/outlet centers): normalized to mesh coordinate space
- Indices 6–8 (inlet velocity): raw m/s from diffuser direction and airflowRate

### 3. Quality Presets

| Quality | Boundary Samples | Interior Samples |
|---------|------------------|------------------|
| `preview` | 1000 | 1000 |
| `standard` | 5000 | 5000 |
| `high` | 20000 | 12000 |

`boundaryCount` and `interiorCount` are optional debug overrides.

### 4. Response Coordinate System

**Decision:** Backend returns world-space positions.

The frontend renders positions directly without any coordinate transform.

---

## Backend Module Structure

```
app/
├── main.py              # FastAPI app, middleware, startup
├── api.py               # Legacy tensor endpoint
├── api_mesh.py          # Primary mesh endpoint
├── schemas.py           # Pydantic request/response models
├── validators.py        # Input validation
├── mesh.py              # STL/OBJ parsing, sampling, normalization
├── mesh_pipeline.py     # Preprocessing: diffuser collapsing, tensor building
├── inference.py         # Model loading and inference execution
├── response_builder.py  # World-space response shaping
├── middleware.py         # Request ID middleware
├── rate_limit.py        # In-memory rate limiter
├── settings.py          # Environment-based configuration
└── models/
    └── ginot.py         # GINOT model + analytic fallback
```

---

## Testing

```bash
.venv/bin/python -m unittest discover tests -v
```

Test coverage:
- Mesh parsing (ASCII STL, OBJ, empty, truncated, unsupported)
- Normalization (center, scale, roundtrip)
- Surface and interior sampling
- Diffuser collapsing (single, multi, edge cases)
- Quality preset resolution
- Mesh endpoint integration (happy path, unsupported file, missing diffuser)
- Legacy tensor endpoint (happy path, validation errors)

---

## Related Documents

- `docs/ginot-backend-api-specification.md` — endpoint contract
- `docs/ginot-backend-frontend-integration.md` — integration guide
- `docs/ginot-model-interface.md` — model input/output semantics
- `docs/260321-2117-ginot-backend-frontend-integration/plan.md` — migration plan
