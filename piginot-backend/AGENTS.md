# AGENTS.md

## Build/Test Commands
- **Run server**: `uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 8000`
- **Run service parity test**: from `lgo/`, `python -m tests.test_serve --device cpu`
- **Build image**: `docker build -t piginot-backend piginot-backend/`
- **Package manager**: `uv`; Python 3.12 is required.

## Architecture
FastAPI inference API around the LGO trained indoor-airflow models from the
`lgo/` source tree. The service predicts for trained, precomputed room cases;
it does not generate CFD cases from arbitrary room geometry.

**Key Components:**
- `app/main.py` - Entrypoint that exposes the LGO FastAPI application
- `lgo/serve/app.py` - HTTP endpoints, request validation, runtime readiness
- `lgo/serve/engine.py` - Model loading, case preparation/cache, and prediction
- `lgo/predict.py`, `lgo/evaluate.py`, `lgo/model/`, `lgo/legacy/` - Upstream inference implementation
- `LGO_MODELS_DIR` - Mounted model-run folders
- `LGO_CASES_DIRS` - Colon-separated roots containing precomputed CFD cases

## Code Style
- Keep the upstream model/inference path intact; route changes belong in `lgo/serve/app.py`.
- Use typed FastAPI/Pydantic request contracts and Python 3.12 syntax.
- Model weights and case CSVs are external runtime assets and must not be committed.
