# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Run Commands

- **Run server**: `python -m app.main` or `uvicorn app.main:app --reload`
- **Run all tests**: `python -m pytest tests/`
- **Run single test**: `python -m pytest tests/test_mesh_pipeline.py::TestMeshPipeline::test_load_ascii_stl -v`
- **Package manager**: `uv` (project uses `uv.lock` for dependency locking)

## Architecture

TurboAPI-based CFD inference backend with PyTorch ML models for fluid dynamics simulation.

**Core Flow:**
1. Client uploads mesh file (STL/OBJ) via REST API
2. `mesh_pipeline.py` processes mesh (normalize, sample points, extract boundary/interior)
3. `inference.py` loads PyTorch model and runs prediction
4. Results returned as JSON with pressure/velocity fields

**Key Components:**
- `app/main.py` - TurboAPI app, CORS middleware, startup model loading, request validation handlers
- `app/api.py` - Main CFD inference endpoints
- `app/api_mesh.py` - Mesh processing endpoints
- `app/inference.py` - PyTorch model runtime & caching
- `app/mesh.py` - Mesh utilities (STL/OBJ loading, normalization, point sampling)
- `app/mesh_pipeline.py` - Full mesh processing pipeline
- `app/schemas.py` - Pydantic models for request/response validation
- `app/settings.py` - Environment configuration (model path, device, rate limits, CORS)
- `app/middleware.py` - Request ID tracking
- `app/rate_limit.py` - In-memory rate limiting
- `app/models/` - Neural network architectures (GINoT, PointNet, Transformer, UNet)
- `app/training/` - Training utilities and configs

**Data Flow:**
- Input: STL/OBJ mesh files in `data/`
- Weights: PyTorch checkpoints in `saved_weights/`
- Config: Environment variables from `.env` (see `.env.example`)

## Code Style

- **Imports**: `from __future__ import annotations`; stdlib → 3rd-party (TurboAPI, torch, numpy) → local
- **Types**: Type hints required; Pydantic models with Field validators for I/O
- **Naming**: snake_case for functions/variables, PascalCase for classes
- **Error Handling**: Custom exception handlers return JSONResponse with detail
- **Logging**: basicConfig with ISO timestamp format
- **Tests**: unittest.TestCase in `tests/` directory
