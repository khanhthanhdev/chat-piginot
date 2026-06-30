# GINOT Model Interface Documentation

## Overview
GINOT (Geometry-Integrated Neural Operator) predicts 3D indoor airflow fields given room geometry and boundary conditions.

---

## Inputs

### 1. `load` — Global Boundary Parameters
**Shape:** `[batch, 9]`
**Type:** `torch.float32`

| Index | Field | Description | Normalized |
|-------|-------|-------------|------------|
| 0-2 | `inlet_center` | [X, Y, Z] center of inlet vent | Yes |
| 3-5 | `outlet_center` | [X, Y, Z] center of outlet vent | Yes |
| 6-8 | `inlet_velocity` | [U, V, W] velocity vector at inlet | No (m/s) |

**Example:**
```python
load = torch.tensor([
    0.15, -0.12, 0.8,   # inlet center (normalized)
    -0.15, 0.1, 0.8,   # outlet center (normalized)
    2.5, 0.0, 0.0      # 2.5 m/s in X direction
], dtype=torch.float32).unsqueeze(0)
```

---

### 2. `pc` — Boundary Point Cloud
**Shape:** `[batch, 100000, 3]`
**Type:** `torch.float32`

- 100K points sampled from room surface (walls, furniture, etc.)
- **Normalized** to unit cube (centered at origin, max dimension = 1)
- Encodes room geometry for the branch network

**Generation:**
```python
mesh = trimesh.load("room.stl")
center = mesh.bounds.mean(axis=0)
scale = (mesh.bounds[1] - mesh.bounds[0]).max()
mesh_norm = mesh.copy()
mesh_norm.apply_translation(-center)
mesh_norm.apply_scale(1.0 / scale)
pc, _ = trimesh.sample.sample_surface(mesh_norm, 100000)
pc = torch.tensor(pc, dtype=torch.float32).unsqueeze(0)
```

---

### 3. `xyt` — Query Points (Interior Collocation Points)
**Shape:** `[batch, N, 3]` (typically N=50000)
**Type:** `torch.float32`

- Interior points where the model predicts airflow
- **Normalized** using same center/scale as boundary points
- Can be uniform grid or random interior samples

**Generation:**
```python
def sample_interior(mesh, N):
    pts = np.random.uniform(mesh.bounds[0], mesh.bounds[1], size=(N, 3))
    inside = mesh.contains(pts)
    return pts[inside]

raw_query = sample_interior(mesh, 50000)
xyt = (raw_query - center) / scale
xyt = torch.tensor(xyt, dtype=torch.float32).unsqueeze(0)
```

---

## Output

### `predictions` — Airflow Field
**Shape:** `[batch, N, 4]`
**Type:** `torch.float32`

| Channel | Field | Description | Units |
|---------|-------|-------------|-------|
| 0 | `U` | X-axis velocity | m/s |
| 1 | `V` | Y-axis velocity | m/s |
| 2 | `W` | Z-axis velocity | m/s |
| 3 | `p` | Pressure | Pa |

**Extraction:**
```python
with torch.no_grad():
    predictions = ginot_model(load=load, xyt=xyt, pc=pc)
    # predictions.shape: [1, 50000, 4]

preds = predictions.squeeze(0).cpu().numpy()  # [N, 4]
coords = xyt.squeeze(0).cpu().numpy()         # [N, 3]

# Denormalize coordinates
original_coords = (coords * scale) + center

# Extract fields
U, V, W, pressure = preds[:, 0], preds[:, 1], preds[:, 2], preds[:, 3]
speed = np.sqrt(U**2 + V**2 + W**2)  # Velocity magnitude
```

---

## Normalization Parameters

The model uses **global mesh normalization**:

```python
center = mesh.bounds.mean(axis=0)  # Mean of min/max corners
scale = (mesh.bounds[1] - mesh.bounds[0]).max()  # Max dimension
```

**Important:** Apply the SAME `center` and `scale` to:
1. Boundary point cloud (`pc`)
2. Query points (`xyt`)
3. Inlet/outlet centers in `load`

Only velocity values in `load` (indices 6-8) are **NOT normalized**.

---

## Integration for Heatmap Visualization

### Data Flow for Web App

```
1. User uploads/creates room mesh (STL/OBJ)
         ↓
2. Extract center/scale normalization params
         ↓
3. Sample 100K boundary points → pc [1, 100000, 3]
4. Sample N interior query points → xyt [1, N, 3]
5. Build boundary params → load [1, 9]
         ↓
6. Run GINOT inference → predictions [1, N, 4]
         ↓
7. Denormalize: original_coords = (xyt * scale) + center
         ↓
8. Extract speed = sqrt(U² + V² + W²)
         ↓
9. Pass to Three.js heatmap: { positions: [N,3], values: [N] }
```

### Three.js Heatmap Data Structure

```typescript
interface HeatmapData {
  positions: Float32Array  // [x,y,z, x,y,z, ...] denormalized
  velocities: Float32Array // [u,v,w, u,v,w, ...]
  speed: Float32Array      // [s, s, s, ...] scalar magnitude
  pressure?: Float32Array  // optional pressure field
  bounds: {                // original room bounds for camera
    min: [number, number, number]
    max: [number, number, number]
  }
}
```

---

## Model Architecture Summary

```
┌─────────────┐
│ load [1,9]  │───→ loading_encoder → [1, embed_dim]
└─────────────┘

┌─────────────┐
│ pc [1,100K,3]│───→ branch (PointCloudPerceiver) → [1, 512, embed_dim]
└─────────────┘

┌─────────────┐
│ xyt [1,N,3] │───→ pos_encoding → Q_encoder → [1, N, embed_dim]
└─────────────┘

                    ↓
        Merge: latent = concat(branch_out, load_expanded)
                    ↓
        5× ResidualCrossAttentionBlock(Q=xyt, K/V=latent)
                    ↓
        output_proj → [1, N, 4] (U, V, W, p)
```

---

## Key Files

- **Model definition:** `docs/model-python.py` (lines 135-205 for `Trunk` class)
- **Config:** `configs.LUG_GINOT_configs()` (branch/trunk hyperparams)
- **Weights:** `ginot_trained_multicase.pth`

---

## API Contract for Editor Integration

The production endpoint is `POST /api/hvac-inference-mesh`. The backend owns all preprocessing
(mesh parsing, normalization, sampling, tensor building) and returns world-space results.

See `docs/ginot-backend-api-specification.md` for the full request/response contract.

Response positions are world coordinates — the frontend does not denormalize anything.
Response velocities are in m/s and pressure is in Pa.

### Physics-boundary checkpoints

The backend also detects the Fourier physics-boundary model from `full.py`. Its point cloud is
`[batch, N, 12]`: normalized XYZ, five boundary masks, and normalized UVWP values. Use only
`POST /api/hvac-inference-mesh`; the backend builds these features and restores model outputs to
physical units.

The checkpoint must include the training normalization:

```python
torch.save({
    "state_dict": model.state_dict(),
    "model_config": {"branch_args": branch_args, "trunk_args": trunk_args},
    "normalization": {
        "coord_min": dataset.coord_min.tolist(),
        "coord_scale": dataset.coord_scale.tolist(),
        "target_mean": dataset.target_mean.tolist(),
        "target_std": dataset.target_std.tolist(),
    },
}, "ginot_physics.pth")
```

For an existing raw state dictionary, put the same `model_config` and `normalization` objects in
`ginot_physics.json` beside `ginot_physics.pth`.
