# PiGINOT LGO backend

FastAPI service for the LGO indoor-airflow models from the local
`lgo-digital-twin-handoff` project. The inference implementation is vendored in
[`lgo/`](lgo/); the source handoff is described in [`lgo/HANDOFF.md`](lgo/HANDOFF.md).

## Runtime requirements

- Python 3.12 and `uv`
- One or more model-run directories with `args.json`, `best.pth`, and
  `thermo_stats.pt`
- One or more precomputed case directories, each containing the 21 CSV files
  used by the model
- CPU works; CUDA is selected automatically when available

The trained checkpoints and CFD datasets are runtime assets, not source files.
Keep them in external storage and configure their paths with `LGO_MODELS_DIR`
and `LGO_CASES_DIRS`; they are excluded from Git and Docker build contexts.
`LGO_CASES_DIRS` is a colon-separated list of roots, such as the `gap30` and
`gap58` test-case directories.

For a local checkout beside `lgo-digital-twin-handoff`, run from this folder:

```bash
export LGO_MODELS_DIR="../../lgo-digital-twin-handoff/models"
export LGO_CASES_DIRS="../../lgo-digital-twin-handoff/test_data/gap30:../../lgo-digital-twin-handoff/test_data/gap58"
uv sync
uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

The model directory must contain the default run
`final30_lgo_ginot_lr1e-3`, or set `LGO_DEFAULT_RUN` to a run that is present.
Startup validates the configured model and case folders. The model itself is
loaded on the first request that needs it.

## API

Interactive docs are served at `/docs` and `/redoc`.

| Method and path | Purpose |
| --- | --- |
| `GET /health` | Runtime device and loaded model/case status |
| `GET /models` | Available trained models and reported test metrics |
| `GET /cases` | Available precomputed layouts |
| `GET /cases/{case}` | Room dimensions and supply/return vent centres |
| `POST /cases/{case}/load?run=...` | Preload model/layout and cache its latent representation |
| `DELETE /cases/{case}/load?run=...` | Release a cached layout |
| `POST /cases/{case}/compare?run=...` | Compare a trained prediction with the case's CFD values |
| `POST /predict` | Predict `u`, `v`, `w`, and `T` at query points |
| `POST /slice` | Predict a regular grid on an axis-aligned room slice |

Example:

```bash
curl -s http://localhost:8000/cases/B001
curl -s http://localhost:8000/predict \
  -H 'content-type: application/json' \
  -d '{"case":"B001","points":[[1.0,1.0,1.1]]}'
```

Set `LGO_CORS_ALLOW_ORIGINS` to a comma-separated list of browser origins when
the frontend is hosted on another origin. Leave it unset to disable CORS.

## Current model boundary

This service replaces the previous arbitrary-mesh and six-terminal batch
endpoints. It predicts only for the fixed room and CFD cases present in the
configured case roots. It does not generate a case from a new room or vent
layout; a new layout needs case data produced by the future frontend/CFD
pipeline. The agent-server batch workflow still targets the retired endpoint
and must be migrated as part of that later pipeline work.

## Tests and image

```bash
uv run pytest tests/

# Full parity/inference test; requires the mounted models and CFD cases.
PYTHONPATH=lgo uv run python -m tests.test_serve --device auto

docker build -t piginot-backend .
```

At runtime, mount the model and case directories at `/models` and `/cases`
respectively, or override `LGO_MODELS_DIR` and `LGO_CASES_DIRS`.
