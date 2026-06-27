# Phase 2 Backend Mesh Pipeline Implementation Plan

**Date**: 2026-03-21
**Type**: Feature Implementation
**Status**: Planning
**Context Tokens**: Build a Python backend pipeline that accepts STL geometry and world-space
diffuser data, computes normalization internally, builds `load`, `pc`, and `xyt`, runs GINOT,
and returns world-space results. The repo does not currently contain a `backend/` directory, so
this phase establishes the runtime and test structure for the backend-owned path.

## Executive Summary

Implement the backend as the single owner of geometry preprocessing and GINOT inference. This phase
creates the mesh endpoint, preprocessing pipeline, inference layer, and fixture-driven tests needed
for the frontend to stop building tensors in the browser.

## Context Links

- **Related Plans**:
  `plans/260321-2117-ginot-backend-frontend-integration/plan.md`,
  `plans/260321-2117-ginot-backend-frontend-integration/phase-01-contract-freeze.md`
- **Dependencies**:
  Python runtime, GINOT model weights, mesh parsing library, FastAPI
- **Reference Docs**:
  `docs/ginot-backend-api-specification.md`,
  `docs/ginot-model-interface.md`

## Requirements

### Functional Requirements

- [ ] Accept multipart requests containing STL and diffuser JSON
- [ ] Parse mesh and compute bounds, center, and scale
- [ ] Sample boundary and interior points on the backend
- [ ] Build internal `load`, `pc`, and `xyt` tensors
- [ ] Run GINOT inference and return world-space response fields

### Non-Functional Requirements

- [ ] Standard requests should remain within the interactive latency budget
- [ ] Validation failures should return deterministic 4xx responses
- [ ] Logging and request tracing should be available for debugging

## Architecture Overview

```mermaid
flowchart LR
  REQ[Multipart Request] --> SCHEMA[Pydantic Schemas]
  SCHEMA --> MESH[mesh_pipeline.py]
  MESH --> INFER[inference.py]
  INFER --> RESP[response_builder.py]
  RESP --> API[FastAPI Response]
```

### Key Components

- **FastAPI API layer**: request parsing, validation, and response handling
- **Mesh pipeline**: mesh load, bounds, normalization, boundary/interior sampling
- **Inference service**: model loading, tensor preparation, and execution
- **Response builder**: derive speed, denormalize query positions, attach metadata

### Data Models

- **`GinotMeshRequest`**: STL file, diffuser list, quality/debug options
- **`PreparedInferenceInput`**: normalized `load`, `pc`, `xyt`, plus normalization metadata
- **`GinotMeshResponse`**: world-space positions plus velocity, pressure, speed, bounds, and timing

## Implementation Phases

### Phase 1: Backend Project Skeleton (Est: 1 day)

**Scope**: Create the backend project layout and schemas

**Tasks**:
1. [ ] Create `backend/app/main.py`
2. [ ] Create `backend/app/api.py`
3. [ ] Create `backend/app/schemas.py`
4. [ ] Create `backend/tests/test_schemas.py`

**Acceptance Criteria**:
- [ ] Backend app boots with a placeholder mesh endpoint
- [ ] Request schemas validate basic multipart metadata

### Phase 2: Mesh Pipeline and Inference (Est: 2 days)

**Scope**: Implement preprocessing and model execution

**Tasks**:
1. [ ] Create `backend/app/mesh_pipeline.py`
2. [ ] Create `backend/app/inference.py`
3. [ ] Create `backend/app/response_builder.py`
4. [ ] Add request validation and response shaping in `backend/app/api.py`

**Acceptance Criteria**:
- [ ] Backend can convert STL plus diffuser data into internal model tensors
- [ ] Response positions are returned in world coordinates

### Phase 3: Testing and Observability (Est: 1 day)

**Scope**: Make the backend verifiable and debuggable

**Tasks**:
1. [ ] Create `backend/tests/test_mesh_pipeline.py`
2. [ ] Create `backend/tests/test_api.py`
3. [ ] Add request IDs and structured logs in `backend/app/main.py`
4. [ ] Add fixture meshes under `backend/tests/fixtures/`

**Acceptance Criteria**:
- [ ] Happy-path fixture tests pass
- [ ] Invalid mesh and invalid diffuser cases return clear errors

## Testing Strategy

- **Unit Tests**: mesh parsing, normalization math, tensor-building helpers
- **Integration Tests**: multipart endpoint from fixture STL to response JSON
- **E2E Tests**: one smoke flow from frontend client once Phase 4 is implemented

## Security Considerations

- [ ] Enforce upload size limits for mesh files
- [ ] Reject unsupported file types and malformed multipart payloads
- [ ] Avoid exposing model paths or stack traces in public errors

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| Non-watertight meshes produce no interior samples | High | Validate early and return actionable mesh-quality errors |
| Inference startup is slow due to model loading | High | Load model once at process startup and cache it |
| Backend response drifts from the frozen contract | Medium | Keep schema and fixture tests aligned with Phase 1 docs |

## Quick Reference

### Key Commands

```bash
bun dev
turbo run check-types
python -m pytest backend/tests
```

### Configuration Files

- `backend/app/main.py`: FastAPI app entry
- `backend/app/schemas.py`: request and response schemas
- `.env.example`: backend runtime variables such as model path and device

## TODO Checklist

- [ ] Backend project skeleton created
- [ ] Mesh pipeline implemented
- [ ] Inference service implemented
- [ ] Response builder implemented
- [ ] Fixture tests added
- [ ] Structured logging added

