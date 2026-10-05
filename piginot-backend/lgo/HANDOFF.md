# Handoff: indoor-airflow prediction model for the digital twin

This folder holds the trained models, the held-out test data, the test results,
and the code needed to run the models. The models predict steady-state airflow
in one specific room: velocity (u, v, w) and temperature T at any point in the
room, for a given layout of the six ceiling vents.

**Read [What the model can and cannot do](#what-the-model-can-and-cannot-do)
before designing the app around it.** The most important limit: the model needs
the room's boundary data as input, and for a new vent layout that data
currently comes from a CFD run (see [Predicting a new layout](#predicting-a-new-vent-layout)).

## Contents

| folder | what | size |
|---|---|---|
| `code/` | the model code; `predict.py` is the entry point for the app | 6 MB |
| `models/` | 14 trained models (7 architectures × 2 training sets), one folder each | 383 MB |
| `test_data/` | 46 held-out CFD cases the models never saw in training | 2.9 GB |
| `results/` | test accuracy: `summary.csv` (one row per model) and per-case JSONs | 3 MB |

`test_data/gap30/` (21 cases) and `test_data/gap58/` (25 cases) are the two
test sets. The gap-0.58 cases are vent layouts at least 0.58 m from any
training layout, so they are the harder test of how the model handles layouts
it has not seen. Each model folder name says which training set it used:
`final30_*` models are tested on `gap30`, `final58_*` models on `gap58`.

## Quick start

Needs Python 3.12 and an NVIDIA GPU. CPU works, but slowly.

```bash
# install torch for your CUDA version first (pytorch.org), then:
pip install -r code/requirements.txt

cd code
python predict.py --run ../models/final30_lgo_ginot_lr1e-3 \
    --case ../test_data/gap30/B001 --out B001_pred.csv
```

Expected output (RTX A5000):

```
B001: 566,924 points | setup 4.1 s, prediction 19.1 s on cuda | wrote B001_pred.csv
  against CFD: velocity R2 +0.9687 | velocity MAE 0.0722 m/s | T MAE 0.1837 K
```

Setup can take up to about 75 s the first time a case is read from disk.

To predict at your own points, pass a CSV with columns `x, y, z` in metres:

```bash
python predict.py --run ../models/final30_lgo_ginot_lr1e-3 \
    --case ../test_data/gap30/B001 --query my_points.csv --out my_pred.csv
```

## Which model to use

Use **`final30_lgo_ginot_lr1e-3` (LGO-GINOT)** by default. It is the most
accurate model on the gap-0.30 test set, close to the best on the gap-0.58
set, and it is the model the paper uses as its running example. If the app
will mostly see vent layouts unlike the training layouts, use
**`final58_lgo_gino_lr3e-3` (LGO-GINO)** instead: it is the best model on the
gap-0.58 test set.

Test accuracy, averaged over each test set (full table: `results/summary.csv`):

| model | gap-0.30 velocity R² | gap-0.30 T MAE | gap-0.58 velocity R² | gap-0.58 T MAE |
|---|---|---|---|---|
| **LGO-GINOT** | **0.978** | 0.138 K | 0.936 | 0.244 K |
| LGO-GDON | 0.975 | **0.132 K** | 0.926 | 0.254 K |
| **LGO-GINO** | 0.971 | 0.152 K | **0.942** | **0.234 K** |
| Transolver | 0.967 | 0.174 K | 0.582 | 0.307 K |
| GINO | 0.920 | 0.238 K | 0.644 | 0.318 K |
| GINOT | 0.673 | 0.165 K | 0.347 | 0.308 K |
| DeepONet | 0.641 | 0.156 K | 0.265 | 0.307 K |
| *nearest-layout lookup (no model)* | 0.003 | 0.229 K | −0.081 | 0.342 K |

"Velocity R²" scores u, v and w together over every interior CFD point (1.0 is
perfect, 0 is no better than a constant). The last row copies the CFD field of
the most similar training layout. It is the baseline any useful model has to beat.

The three LGO models are the project's architecture: a host model plus a
"local branch" that looks at the nearest boundary points (vents, walls) from
each query point. The other four are the same hosts without that branch, kept
for comparison. They are not recommended for the app.

Speed on one RTX A5000, measured separately on a quiet GPU
(`results/timing/`):

| model | case setup (once per layout) | per 100,000 query points |
|---|---|---|
| LGO-GINOT | 1.5 s | 1.9 s |
| LGO-GDON | 1.2 s | 1.8 s |
| LGO-GINO | 1.3 s | 2.1 s |

A whole room (about 565,000 points) takes about 10–20 s. A typical
visualisation slice of a few thousand points takes well under a second. The CFD
solve the model replaces takes a median of 24 minutes per layout.

## Using the model from Python

Load once per (model, layout), then query as many points as needed:

```python
import sys
sys.path[:0] = ["code", "code/legacy"]   # paths relative to this folder
import numpy as np
from predict import load, predict_points

model, ds = load("models/final30_lgo_ginot_lr1e-3", "test_data/gap30/B001", device="cuda")

# horizontal plane at 1.1 m, 10 cm grid
x, y = np.meshgrid(np.arange(0.2, 8.6, 0.1), np.arange(0.2, 5.9, 0.1))
pts = np.stack([x.ravel(), y.ravel(), np.full(x.size, 1.1)], axis=1)

out = predict_points(model, ds, pts)   # (N, 5): u, v, w [m/s], p, T [K]
speed = np.linalg.norm(out[:, :3], axis=1)
temperature = out[:, 4]
```

Column 3 of the output is pressure. It is not a validated output; do not show it.

## Running the inference service

`code/serve/` wraps the same code path in a long-running HTTP service
(FastAPI). Each model is loaded once and shared by every layout; each
(model, layout) pair is prepared once and kept warm, so a request only pays
for decoding the query points. Results are identical to `predict.py` at the
same seed (`code/tests/test_serve.py` checks this).

```bash
uv venv -p 3.12 .venv && source .venv/bin/activate
# GPU: the PyPI torch 2.13.0 wheel is a CUDA 13.0 build (tested on an RTX 5050):
uv pip install -r code/requirements.txt -r code/requirements-serve.txt
# CPU-only machine: install the CPU wheel first, then the same line as above:
#   uv pip install torch==2.13.0 --index-url https://download.pytorch.org/whl/cpu

cd code
python -m serve --device auto --port 8000 --preload B001     # auto | cpu | cuda
python -m tests.test_serve --device cuda                     # or --device cpu
```

Interactive API docs are at `http://127.0.0.1:8000/docs`. The model is
`final30_lgo_ginot_lr1e-3` unless a request names another `run`.

| endpoint | does |
|---|---|
| `GET /health` | device, loaded models and layouts |
| `GET /models` | the 14 runs, with test accuracy and the recommended ones |
| `GET /cases`, `GET /cases/{case}` | available layouts; supply and return vent centres |
| `POST /cases/{case}/load?run=` | prepare a layout ahead of time (the 4–75 s setup) |
| `DELETE /cases/{case}/load?run=` | release it |
| `POST /predict` | `{case, run?, points: [[x,y,z],...], outside?: "error"\|"nan"}` → `u, v, w, T`; `?format=npz` for large queries |
| `POST /slice` | `{case, run?, axis: "z", value: 1.1, spacing: 0.1}` → a grid of `u, v, w, T` on that plane |
| `GET /cases/{case}/compare?run=` | prediction vs CFD at the case's own points |

Settings: `LGO_DEVICE`, `LGO_MODELS_DIR`, `LGO_CASES_DIRS` (`:`-separated
roots searched for case folders), `LGO_MAX_CASES` (warm layouts, default 4;
each takes a few hundred MB), `LGO_DEFAULT_RUN`, `LGO_SEED`,
`LGO_MAX_POINTS`. On CPU, `--threads N` sets torch threads and the KD-tree
workers. The service runs as one process: requests are served one at a time
on the model, so put several processes behind a load balancer if needed.

Two model behaviours show up through the service (they come from the models,
not the service, and `predict.py` behaves the same way). The GINO-based
models are not bit-reproducible on GPU: the same query twice can differ by
about 0.001 m/s. Transolver's prediction at a point depends on the other
points queried in the same call. The recommended LGO-GINOT model has neither
behaviour.

A new layout is served by dropping its 21-CSV folder into a case root and
restarting; the limits in [Predicting a new layout](#predicting-a-new-vent-layout)
still apply.

## Input format

A case is a folder of 21 CSV files, one per boundary patch plus one for the
interior. This is the format of every folder in `test_data/`. Coordinates are
in metres, with the room spanning x 0–8.80, y 0–6.10, z 0–3.20.

| file | contents | what the model uses |
|---|---|---|
| `New_HVAC.csv` | the six ceiling vent panels (3 supply, 3 return), one row per mesh face | positions; supply velocity and temperature |
| `Leak.csv` | the leakage gap | positions; leak speed |
| 18 wall and furniture files (`Ceiling.csv`, `Floor.csv`, `Wall_01.csv`, `Table.csv`, ...) | room surfaces | positions only |
| `Fluid_data.csv` | the interior CFD points and solution | **nothing as model input**, but the loader requires it (see below) |

Columns: `X (m)`, `Y (m)`, `Z (m)`, `Velocity[i] (m/s)`, `Velocity[j] (m/s)`,
`Velocity[k] (m/s)`, `Pressure (Pa)` and, in `Fluid_data.csv` and
`New_HVAC.csv`, `Temperature (K)`.

The model never sees the solution: return-vent velocity, pressure and the
interior values are all hidden from its input. So the reported accuracy is
genuine prediction, not copying.

## Output format

`predict.py` writes CSV (or `.npz` if `--out` ends in `.npz`) with columns
`x, y, z, u, v, w, T`. When no `--query` file is given, the points are the
case's own CFD points, and the file also has the CFD values `u_cfd, v_cfd,
w_cfd, T_cfd` for comparison.

## Predicting a new vent layout

**This is the main gap for a digital twin, and it is not solved here.** The
model itself only needs the boundary geometry and the supply-vent conditions.
But the loader in this code builds them from a solved CFD case, in two ways:

1. **It requires `Fluid_data.csv`**, the interior points, and refuses a case
   without it. It reads no solution values from it as model input.
2. **It tells supply vents from return vents by the solved velocity** in
   `New_HVAC.csv`. Each vent panel is classed by the sign of its net vertical
   velocity: downward means supply, upward means return.

So every case in `test_data/` works, but a brand-new layout needs its 21 CSVs
first. Today those come from the CFD pipeline in `code/cfd/` (see
`code/cfd/README.md`), which meshes and solves the case: about 25 minutes per
layout on 8 cores.

To predict a new layout **without** CFD, the app needs an input generator that
writes the same files without solving. That means:

- the vent panels placed at the new positions, with face centres on the
  ceiling and the supply velocity profile from `code/cfd/vent_profile.json`;
- the walls and furniture, which are fixed in this room, so they can be copied
  from any existing case. The ceiling is the exception: it must be re-cut
  where the vents move;
- return vents marked by patch membership rather than by velocity sign;
- a placeholder `Fluid_data.csv`.

None of this has been built or tested. Until it has been checked against CFD,
the accuracy above does not carry over to generated inputs. The mesh face
spacing in particular might matter, because the model sees a random
15,000-point sample of the boundary.

## What the model can and cannot do

- **One room only.** Every training case is the same room, with the same
  furniture, flow rate, supply temperature and wall conditions. Only the
  positions of the six ceiling vents vary. Do not expect it to work for another
  room, a different number of vents, or other flow rates or supply
  temperatures, even though the input format would accept them.
- **Vent layouts inside the trained range.** Layouts are 3 supply + 3 return
  panels on the ceiling, within the design ranges in `code/cfd/sweep.py`.
  Accuracy falls the further a layout is from the training layouts: compare
  the gap-0.30 and gap-0.58 columns above.
- **Strong on jets and the room-scale flow; weaker in the occupied zone.** In
  the seated-height comfort band (ASHRAE 55: 0.1–1.35 m, away from walls), the
  models beat a plain lookup of the most similar training layout by only a
  little: velocity correlation 0.73–0.78 against 0.73 on gap-0.30, and
  0.66–0.67 against 0.61 on gap-0.58 (`ashrae_seated_velocity_rho` in
  `summary.csv`). Over the whole room the gap is 0.97 against 0.00 velocity R².
  Partly this is because the CFD itself is not converged there: two snapshots
  of the same case agree only weakly in that band. So treat comfort-zone
  velocities as indicative, not precise. Temperature is reliable throughout: errors are
  about 0.13–0.25 K.
- **Steady-state RANS.** The CFD is k–ε steady-state, which for this room is a
  snapshot of a slightly unsteady flow. The model predicts that snapshot, not a
  time average or transients.
- **The predicted field has small jumps.** Each query point uses its nearest
  boundary points, so moving a point by a tiny amount can change the
  prediction by up to about 0.04 m/s when the set of nearest points changes.
  This is invisible in plots and averages, but do not take numerical
  derivatives of the predicted field (vorticity, divergence) without
  smoothing first.
- **Results vary slightly between runs.** The model sees a random sample of
  15,000 boundary points, so repeated predictions differ by a few thousandths
  of R². `--seed` (default 0) fixes the sample, so the same command gives the
  same answer. On test case D010 with LGO-GINO, five seeds gave velocity R²
  0.952–0.956, against 0.957 in the results file.

## Test results in more detail

- `results/summary.csv`: one row per model and test set, plus the two
  no-model baselines. `make_summary.py` rebuilds it from the JSONs.
- `results/test/*.json`: the full evaluation per model. `per_case` holds every
  metric for each test case, `mean` the averages, and `mean_zones` splits the
  room into near-jet (<1 m from a supply vent), transition and far field.
  `mean_comfort` covers the ASHRAE comfort bands.
- `results/timing/`: the inference timings above, with hardware details.

To look at a prediction, run `predict.py` on a test case and plot the
`x, y, z, u, v, w, T` columns against `u_cfd, v_cfd, w_cfd, T_cfd`.

The test sets were used once, for the paper. That does not restrict them here:
use them freely to test the app.

## Code

`code/` is the project's release code (`README.md`, `USAGE.md` and
`REPRODUCING.md` explain training and evaluation). The only file added for this
handoff is `code/predict.py`. Each model folder holds `args.json` (how the
model was built and trained), `best.pth` (weights), `thermo_stats.pt` (its
normalisation, required) and `history.json` (training log). Keep these four
files together: the model is rebuilt from its own `args.json`.

Full dataset (193 cases, CC-BY-4.0): https://doi.org/10.5281/zenodo.22955315
