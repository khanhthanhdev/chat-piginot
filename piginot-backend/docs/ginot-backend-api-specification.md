# GINOT Backend API Specification

Primary goal: the backend owns preprocessing and inference, and the frontend remains a thin layer
that exports room geometry, sends semantic diffuser data, and renders the returned airflow fields.

## Supported Endpoints

### `POST /api/hvac-inference-mesh`

Primary production endpoint. Accepts room geometry plus world-space diffuser descriptors and builds
all model tensors on the backend.

Request content type:

```http
multipart/form-data
```

Multipart fields:

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `meshFile` | file | Yes | STL is the primary supported format. `mesh_file` is also accepted for compatibility. |
| `diffusers` | JSON array | Yes | Supply/return diffuser descriptors in world coordinates. |
| `options` | JSON object | No | Quality preset and optional debug overrides. |
| `context` | JSON object | No | Project/level/zone identifiers for tracing. |

Diffuser payload:

```json
[
  {
    "id": "supply-1",
    "kind": "supply",
    "center": [5.2, 2.4, 1.8],
    "direction": [0.0, -1.0, 0.0],
    "airflowRate": 1.8
  },
  {
    "id": "return-1",
    "kind": "return",
    "center": [5.2, 2.4, 8.1]
  }
]
```

Diffuser rules:

| Rule | Meaning |
|------|---------|
| At least one `supply` diffuser is required | Backend derives inlet center and inlet velocity from supply diffusers. |
| At least one `return` diffuser is required | Backend derives the outlet center from return diffusers. |
| At least one supply diffuser must have non-zero `direction` | Required to produce the model inlet velocity vector. |
| `center` and `direction` must contain 3 finite values | Request is rejected otherwise. |
| Diffuser IDs must be unique | Duplicate IDs are rejected. |

Velocity derivation:

- If `airflowRate` is provided, the backend treats it as inlet speed magnitude in m/s and combines
  it with the `direction` unit vector.
- If `airflowRate` is omitted for a supply diffuser, the backend uses the `direction` vector
  magnitude directly as the inlet velocity magnitude.
- Multiple supply/return diffusers are collapsed into the current 9-value GINOT `load` vector by
  weighted averaging on the backend.

Options payload:

```json
{
  "quality": "standard",
  "boundaryCount": 5000,
  "interiorCount": 5000,
  "returnGrid3D": false
}
```

Quality presets:

| Quality | Boundary Samples | Interior Samples |
|---------|------------------|------------------|
| `preview` | 1000 | 1000 |
| `standard` | 5000 | 5000 |
| `high` | 20000 | 12000 |

Notes:

- `boundaryCount` and `interiorCount` are optional debug overrides.
- The backend validates these counts against configured service limits.
- `returnGrid3D` is accepted for forward compatibility but does not currently add extra response
  payloads.

Response body:

```json
{
  "positions": [[5.0, 1.2, 3.4], [5.1, 1.2, 3.5]],
  "velocities": [[0.6, -0.1, 0.0], [0.4, -0.2, 0.0]],
  "pressure": [101325.2, 101325.8],
  "speed": [0.608, 0.447],
  "bounds": {
    "min": [0.0, 0.0, 0.0],
    "max": [10.0, 2.8, 10.0]
  },
  "metadata": {
    "inletCenter": [5.2, 2.4, 1.8],
    "outletCenter": [5.2, 2.4, 8.1],
    "inletVelocity": [0.0, -1.8, 0.0],
    "boundaryCount": 5000,
    "interiorCount": 5000,
    "quality": "standard",
    "supplyDiffuserIds": ["supply-1"],
    "returnDiffuserIds": ["return-1"],
    "modelSource": "analytic-fallback"
  },
  "inferenceId": "ginot_abc12345",
  "timestamp": 1774056554123,
  "computeTimeMs": 842.31
}
```

Response semantics:

| Field | Meaning |
|-------|---------|
| `positions` | World-space interior query points, ready to render without denormalization. |
| `velocities` | Air velocity vectors in m/s. |
| `pressure` | Pressure field in Pa. |
| `speed` | Derived velocity magnitude in m/s. |
| `bounds` | World-space mesh bounds. |
| `metadata` | Backend-derived inlet/outlet information and request sampling details. |

Failure responses:

| Status | Example Cases |
|--------|---------------|
| `400` | Invalid mesh, malformed JSON, missing supply/return diffusers, duplicate diffuser IDs, invalid sampling overrides, no interior points sampled |
| `504` | Inference exceeded configured timeout |
| `500` | Runtime or model failure |

### `POST /api/hvac-inference`

Legacy/debug endpoint. Accepts prebuilt `load`, `pc`, and `xyt` tensors directly as JSON.

Use this only for fixture testing, debugging, or controlled experiments. Production frontend code
should call `POST /api/hvac-inference-mesh` instead.

## Backend Processing Ownership

For `POST /api/hvac-inference-mesh`, the backend owns:

1. Mesh parsing and validation.
2. Bounds, center, and scale computation.
3. Boundary sampling for `pc`.
4. Interior sampling for `xyt`.
5. Diffuser collapsing and normalized `load` construction.
6. GINOT inference execution.
7. Derived `speed` calculation.
8. World-space response shaping.
