# AGENTS.md

## Build/Test Commands
- **Run server**: `python -m app.main` or `uvicorn app.main:app --reload`
- **Run all tests**: `python -m pytest tests/`
- **Run single test**: `python -m pytest tests/test_mesh_pipeline.py::TestMeshPipeline::test_load_ascii_stl -v`
- **Linting**: Uses standard Python style (no formal linter configured)

## Architecture
TurboAPI-based CFD inference backend with PyTorch ML models.

**Key Components:**
- `app/main.py` - TurboAPI app, CORS/rate-limit middleware, startup model loading
- `app/api.py` - Main CFD inference endpoints
- `app/api_mesh.py` - Mesh processing endpoints
- `app/inference.py` - PyTorch model runtime & caching
- `app/mesh.py` - Mesh utilities (normalize, sample points, load STL/OBJ)
- `app/mesh_pipeline.py` - Mesh processing pipeline
- `app/schemas.py` - Pydantic models (GinotInferenceRequest, DiffuserInput, MeshInferenceOptions)
- `app/settings.py` - Environment config (CORS, rate limits, model path, device preference)
- `app/middleware.py` - Request ID tracking
- `app/rate_limit.py` - Memory-based rate limiting

**Data**: STL/OBJ mesh files, PyTorch checkpoints in `saved_weights/`

## Code Style
- **Imports**: `from __future__ import annotations` at top; stdlib, 3rd-party (TurboAPI, torch, numpy), local imports
- **Types**: Pydantic models with Field validators; type hints required
- **Naming**: snake_case for functions/vars, PascalCase for classes/models
- **Error Handling**: Custom exception handlers for RequestValidationError; return JSONResponse with detail
- **Logging**: basicConfig with ISO timestamp format
- **Tests**: unittest.TestCase in `tests/` (e.g., test_mesh_pipeline.py)
