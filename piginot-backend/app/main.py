from __future__ import annotations

from contextlib import asynccontextmanager
import logging
from typing import TYPE_CHECKING

from fastmcp import FastMCP
import torch
from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware

from .api import router as api_router
from .api_mesh import router as api_mesh_router
from .errors import request_validation_exception_handler
from .inference import get_inference_runtime
from .middleware import RequestIdMiddleware
from .rate_limit import MemoryRateLimitMiddleware
from .settings import get_settings

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)

SETTINGS = get_settings()


if TYPE_CHECKING:
    from collections.abc import AsyncIterator


@asynccontextmanager
async def lifespan(api_app: FastAPI) -> AsyncIterator[None]:
    get_inference_runtime(
        str(SETTINGS.model_path),
        SETTINGS.device_preference,
        SETTINGS.allow_fallback_model,
        SETTINGS.inference_engine,
        str(SETTINGS.onnx_model_path),
    )
    async with mcp_app.lifespan(api_app):
        yield


app = FastAPI(
    title="GINOT CFD Inference API",
    version="0.1.0",
    description="FastAPI-based CFD inference backend for HVAC analysis using PyTorch models. Supports mesh-based and point cloud inference with boundary and interior point sampling.",
    contact={
        "name": "CFD Team",
        "url": "https://example.com",
    },
    license_info={
        "name": "MIT",
    },
    docs_url="/docs",
    openapi_url="/openapi.json",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=list(SETTINGS.cors_allow_origins),
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)
app.add_middleware(RequestIdMiddleware)
app.add_middleware(
    MemoryRateLimitMiddleware,
    limit=SETTINGS.rate_limit_times,
    window_seconds=SETTINGS.rate_limit_window_seconds,
)

app.add_exception_handler(RequestValidationError, request_validation_exception_handler)

app.include_router(api_router)
app.include_router(api_mesh_router)


@app.get(
    "/",
    summary="Service Status",
    description="Root endpoint that returns basic service information.",
    tags=["health"],
)
async def root() -> dict[str, str]:
    return {"status": "ok", "service": "piginot-backend"}


@app.get(
    "/health",
    summary="Health Check",
    description="Returns detailed health status including PyTorch device availability, model source, and loaded checkpoint path.",
    tags=["health"],
)
async def health() -> dict[str, object]:
    runtime = get_inference_runtime(
        str(SETTINGS.model_path),
        SETTINGS.device_preference,
        SETTINGS.allow_fallback_model,
        SETTINGS.inference_engine,
        str(SETTINGS.onnx_model_path),
    )
    return {
        "status": "healthy",
        "torch_version": torch.__version__,
        "cuda_available": torch.cuda.is_available(),
        "device": runtime.device,
        "inference_engine": runtime.engine,
        "model_source": runtime.source,
        "model_path": runtime.checkpoint_path,
    }


mcp = FastMCP.from_fastapi(app=app, name="Piginot Backend MCP")
mcp_app = mcp.http_app(path="/")
app.mount("/mcp", mcp_app)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
