from __future__ import annotations

import logging
import time

import numpy as np

from ..inference import get_inference_runtime, run_inference
from ..mesh import denormalize_points
from ..response_builder import (
    build_bounds_from_points,
    build_inference_response,
    build_response_metadata_from_load,
)
from ..schemas import GinotInferenceRequest, GinotInferenceResponse
from ..settings import get_settings
from ..validators import build_model_inputs, validate_request
from .common import compute_elapsed_time_ms, ensure_within_timeout


LOGGER = logging.getLogger(__name__)


def execute_legacy_inference(request: GinotInferenceRequest) -> GinotInferenceResponse:
    settings = get_settings()
    started_at = time.perf_counter()

    counts = validate_request(
        request,
        max_boundary_points=settings.max_boundary_points,
        max_interior_points=settings.max_interior_points,
    )
    LOGGER.info(
        "inference_flow=legacy boundary=%d interior=%d",
        counts.boundary_count,
        counts.interior_count,
    )

    load, pc, xyt = build_model_inputs(request)
    runtime = get_inference_runtime(
        str(settings.model_path),
        settings.device_preference,
        settings.allow_fallback_model,
        settings.inference_engine,
        str(settings.onnx_model_path),
    )
    prediction = run_inference(
        load=load,
        pc=pc,
        xyt=xyt,
        model=runtime.model,
        device=runtime.device,
        engine=runtime.engine,
    )
    compute_time_ms = compute_elapsed_time_ms(started_at)
    ensure_within_timeout(compute_time_ms, settings.inference_timeout_seconds)

    center = request.metadata.center if request.metadata else None
    scale = float(request.metadata.scale) if request.metadata and request.metadata.scale is not None else None
    response_positions = _response_positions(prediction.positions, center=center, scale=scale)

    LOGGER.info("inference_flow=legacy completed_ms=%.1f", compute_time_ms)
    return build_inference_response(
        positions=response_positions,
        prediction=prediction,
        bounds=build_bounds_from_points(_request_points_world_space(request)),
        metadata=build_response_metadata_from_load(
            request.load,
            center=center,
            scale=scale,
            boundary_count=counts.boundary_count,
            interior_count=counts.interior_count,
            model_source=runtime.source,
        ),
        compute_time_ms=compute_time_ms,
    )


def _request_points_world_space(request: GinotInferenceRequest) -> np.ndarray:
    coords = np.concatenate(
        [
            np.asarray(request.pc, dtype=np.float32).reshape(-1, 3),
            np.asarray(request.xyt, dtype=np.float32).reshape(-1, 3),
        ],
        axis=0,
    )

    if request.metadata and request.metadata.center is not None and request.metadata.scale is not None:
        center = np.asarray(request.metadata.center, dtype=np.float32)
        scale = float(request.metadata.scale)
        return denormalize_points(coords, center, scale)

    return coords


def _response_positions(
    positions: np.ndarray,
    *,
    center: list[float] | None,
    scale: float | None,
) -> np.ndarray:
    if center is None or scale is None:
        return positions
    return denormalize_points(positions, np.asarray(center, dtype=np.float32), scale)
