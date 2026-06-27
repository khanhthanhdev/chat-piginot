# OpenAPI Schema Documentation

## Overview

The GINOT CFD Inference API uses OpenAPI 3.1.0 standard for comprehensive API documentation. The schema is automatically generated from Pydantic models and FastAPI route decorators.

**Access the interactive API docs:**
- Swagger UI: `http://localhost:8000/docs`
- ReDoc: `http://localhost:8000/redoc`
- Raw OpenAPI JSON: `http://localhost:8000/openapi.json`

---

## API Information

- **Title**: GINOT CFD Inference API
- **Version**: 0.1.0
- **Description**: FastAPI-based CFD inference backend for HVAC analysis using PyTorch models. Supports mesh-based and point cloud inference with boundary and interior point sampling.
- **License**: MIT
- **Contact**: CFD Team

---

## Endpoints

### Health & Status

#### `GET /`
**Summary:** Service Status

Returns basic service information.

**Response:** `{"status": "ok", "service": "piginot-backend"}`

---

#### `GET /health`
**Summary:** Health Check

Returns detailed health status including PyTorch device availability, model source, and loaded checkpoint path.

**Response Fields:**
- `status`: "healthy"
- `torch_version`: PyTorch version
- `cuda_available`: Boolean indicating CUDA availability
- `device`: Current compute device (cuda/cpu)
- `model_source`: Source of loaded model
- `model_path`: Path to model checkpoint

---

#### `GET /test-room`
**Summary:** Test Room Data Inspector

Debug endpoint that loads and inspects the `test_room.pt` file structure and contents.

---

### CFD Inference

#### `POST /api/hvac-inference`
**Summary:** HVAC CFD Inference

Perform CFD inference on HVAC system using pre-sampled boundary and interior query points.

**Use Case:** Direct inference when you have pre-processed point clouds and normalized coordinates.

**Request Model:** `GinotInferenceRequest`
```json
{
  "load": [number, ...],        // 9-element array
  "pc": [number, ...],           // Flattened [N*3] boundary points
  "xyt": [number, ...],          // Flattened [M*3] interior query points
  "metadata": {
    "boundaryCount": 0,          // Optional
    "interiorCount": 0,          // Optional
    "center": [0, 0, 0],        // Optional [x, y, z]
    "scale": 1.0                // Optional scale factor
  }
}
```

**Response Model:** `GinotInferenceResponse`
```json
{
  "positions": [[number, number, number], ...],      // [M][3]
  "velocities": [[number, number, number], ...],     // [M][3]
  "pressure": [number, ...],                         // [M]
  "speed": [number, ...],                            // [M]
  "bounds": {
    "min": [number, number, number],
    "max": [number, number, number]
  },
  "metadata": {
    "inletCenter": [number, number, number],
    "outletCenter": [number, number, number],
    "inletVelocity": [number, number, number],
    "boundaryCount": 0,
    "interiorCount": 0,
    "quality": "standard",
    "supplyDiffuserIds": ["string"],
    "returnDiffuserIds": ["string"],
    "modelSource": "string"
  },
  "inferenceId": "string",
  "timestamp": 0,
  "computeTimeMs": 0.0
}
```

**Status Codes:**
- `200`: Successful inference result
- `400`: Invalid request parameters (insufficient points, invalid metadata)
- `422`: Validation error in request body
- `504`: Inference exceeded configured timeout
- `500`: Internal server error

---

#### `POST /api/hvac-inference-mesh`
**Summary:** HVAC Mesh-Based CFD Inference

Perform CFD inference directly from a mesh file (STL/OBJ). The endpoint handles mesh preprocessing, point sampling, and diffuser placement.

**Use Case:** Full end-to-end inference when you have a 3D mesh and diffuser definitions.

**Request Format:** `multipart/form-data`

**Form Fields:**
- `meshFile` (file, required): STL or OBJ mesh file
- `diffusers` (string, required): JSON array of diffuser configurations
- `options` (string, optional): JSON object for sampling options
- `context` (string, optional): JSON object for tracking metadata

**Diffuser Configuration Example:**
```json
{
  "diffusers": [
    {
      "id": "supply_1",
      "kind": "supply",
      "center": [0.0, 0.0, 3.0],
      "direction": [0.0, 0.0, -1.0],
      "airflowRate": 2.5
    },
    {
      "id": "return_1",
      "kind": "return",
      "center": [5.0, 5.0, 0.5],
      "direction": [0.0, 0.0, 1.0]
    }
  ],
  "options": {
    "quality": "standard",
    "boundaryCount": 5000,
    "interiorCount": 10000,
    "returnGrid3D": false
  },
  "context": {
    "projectId": "proj_123",
    "levelId": "level_2",
    "zoneId": "zone_a"
  }
}
```

**Response Model:** `GinotInferenceResponse` (same as direct inference)

**Status Codes:**
- `200`: Successful mesh inference
- `400`: Invalid mesh, diffuser configuration, or form data
- `422`: Validation error
- `504`: Mesh processing or inference exceeded timeout
- `500`: Internal error during processing

---

## Request/Response Models

### GinotInferenceRequest

Direct CFD inference request.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `load` | array[float] | ✓ | 9-element load vector representing HVAC boundary conditions |
| `pc` | array[float] | ✓ | Flattened boundary point cloud [x₁, y₁, z₁, x₂, y₂, z₂, ...]. N = len(pc)/3 |
| `xyt` | array[float] | ✓ | Flattened interior query points [x₁, y₁, z₁, ...]. M = len(xyt)/3 |
| `metadata` | MetadataInput | ✗ | Optional normalization metadata (center, scale for world space conversion) |

### MetadataInput

Normalization and context metadata.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `boundaryCount` | integer | ✗ | Number of boundary points (informational) |
| `interiorCount` | integer | ✗ | Number of interior query points (informational) |
| `center` | array[float] | ✗ | Normalization center [x, y, z] - used to denormalize results to world space |
| `scale` | float | ✗ | Normalization scale factor - used to denormalize results to world space |

### MeshInferenceRequest

Mesh-based CFD inference request (in multipart form data).

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `diffusers` | array[DiffuserInput] | ✓ | List of diffusers (min 2) |
| `options` | MeshInferenceOptions | ✗ | Sampling quality options |
| `context` | MeshInferenceContext | ✗ | Project/level/zone tracking metadata |

### DiffuserInput

HVAC diffuser configuration.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | ✓ | Unique diffuser identifier |
| `kind` | string | ✓ | "supply" or "return" |
| `center` | array[float] | ✓ | Diffuser center location [x, y, z] |
| `direction` | array[float] | ✗ | Flow direction [dx, dy, dz] (normalized internally) |
| `airflowRate` | float | ✗ | Inlet speed in m/s (uses direction magnitude if omitted for supply) |

### MeshInferenceOptions

Mesh sampling configuration.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `quality` | string | "standard" | "preview", "standard", or "high" - controls point density |
| `boundaryCount` | integer | null | Target boundary points (≥100, or null for quality-based default) |
| `interiorCount` | integer | null | Target interior points (≥1, or null for quality-based default) |
| `returnGrid3D` | boolean | false | If true, return results as 3D grid instead of point cloud |

### MeshInferenceContext

Optional request context for tracking.

| Field | Type | Description |
|-------|------|-------------|
| `projectId` | string | Project identifier |
| `levelId` | string | Level/floor identifier |
| `zoneId` | string | Zone/room identifier |

### GinotInferenceResponse

CFD inference results.

| Field | Type | Description |
|-------|------|-------------|
| `positions` | array[array[float]] | Query point coordinates [M][3] |
| `velocities` | array[array[float]] | Velocity vectors [M][3] - each [vx, vy, vz] |
| `pressure` | array[float] | Static pressure at each point [M] |
| `speed` | array[float] | Velocity magnitude (speed) [M] |
| `bounds` | Bounds | Domain bounding box |
| `metadata` | ResponseMetadata | Simulation and configuration metadata |
| `inferenceId` | string | Unique request identifier (e.g., "ginot_abc12345") |
| `timestamp` | integer | Unix timestamp in milliseconds |
| `computeTimeMs` | float | Total computation time in milliseconds |

### Bounds

Spatial domain bounds.

| Field | Type | Description |
|-------|------|-------------|
| `min` | array[float] | Minimum corner [x_min, y_min, z_min] |
| `max` | array[float] | Maximum corner [x_max, y_max, z_max] |

### ResponseMetadata

Simulation configuration and results metadata.

| Field | Type | Description |
|-------|------|-------------|
| `inletCenter` | array[float] | Supply/inlet diffuser center [x, y, z] |
| `outletCenter` | array[float] | Return/outlet diffuser center [x, y, z] |
| `inletVelocity` | array[float] | Inlet velocity vector [vx, vy, vz] |
| `boundaryCount` | integer | Number of boundary points sampled |
| `interiorCount` | integer | Number of interior query points |
| `quality` | string | Mesh sampling quality used |
| `supplyDiffuserIds` | array[string] | Supply diffuser IDs processed |
| `returnDiffuserIds` | array[string] | Return diffuser IDs processed |
| `modelSource` | string | Model source (e.g., "checkpoint", "fallback") |

---

## Example Requests

### Direct Inference Example

```bash
curl -X POST "http://localhost:8000/api/hvac-inference" \
  -H "Content-Type: application/json" \
  -d '{
    "load": [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
    "pc": [0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 2.0, 2.0, 2.0],
    "xyt": [0.5, 0.5, 0.5, 1.5, 1.5, 1.5],
    "metadata": {
      "center": [1.0, 1.0, 1.0],
      "scale": 2.0
    }
  }'
```

### Mesh Inference Example

```bash
curl -X POST "http://localhost:8000/api/hvac-inference-mesh" \
  -F "meshFile=@room.stl" \
  -F 'diffusers=[
    {"id":"s1","kind":"supply","center":[0,0,3],"direction":[0,0,-1],"airflowRate":2.5},
    {"id":"r1","kind":"return","center":[5,5,0.5],"direction":[0,0,1]}
  ]' \
  -F 'options={"quality":"standard","boundaryCount":5000,"interiorCount":10000}'
```

---

## Error Handling

### Validation Error (422)

```json
{
  "detail": [
    {
      "type": "value_error",
      "loc": ["body", "load"],
      "msg": "ensure this value has at least 9 items",
      "input": [1.0, 2.0]
    }
  ]
}
```

### Request Error (400)

```json
{
  "detail": "Invalid request body; load: ensure this value has at least 9 items"
}
```

### Server Error (500)

```json
{
  "detail": "Inference failed: [error details]"
}
```

### Timeout Error (504)

```json
{
  "detail": "Inference exceeded configured timeout"
}
```

---

## Tags

Endpoints are organized by tags:

- **`health`**: Service status and health checks
- **`debug`**: Debug and inspection endpoints
- **`ginot`**: Direct CFD inference operations
- **`ginot-mesh`**: Mesh-based CFD inference operations

---

## Notes

1. All numeric arrays are flattened (not nested) in request bodies for efficiency
2. Coordinates can be in either normalized or world space (specify via metadata)
3. Inference computation time is typically 50-500ms depending on point counts
4. Request IDs are tracked for debugging and performance analysis
5. CORS is configured to allow requests from configured origins
6. Rate limiting is enforced at the middleware level
