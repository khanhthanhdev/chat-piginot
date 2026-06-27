from __future__ import annotations

import logging
import time
import uuid

import numpy as np

from ..http.mesh_form import MultipartFilePart
from ..inference import get_inference_runtime, run_inference
from ..mesh_pipeline import preprocess_mesh_inference
from ..response_builder import (
    build_bounds_from_points,
    build_inference_response,
    build_response_metadata,
)
from ..schemas import GinotInferenceResponse, MeshInferenceRequest
from ..settings import get_settings
from ..validators import validate_mesh_request
from .common import compute_elapsed_time_ms, ensure_within_timeout
from .visualization_service import generate_pressure_velocity_visualization


LOGGER = logging.getLogger(__name__)


def execute_mesh_inference(
    mesh_request: MeshInferenceRequest,
    mesh_file: MultipartFilePart,
    *,
    request_id: str,
) -> GinotInferenceResponse:
    settings = get_settings()
    started_at = time.perf_counter()

    if not mesh_file.content:
        raise ValueError("Mesh file is empty")

    validation = validate_mesh_request(
        mesh_request,
        filename=mesh_file.filename,
        max_boundary_points=settings.max_boundary_points,
        max_interior_points=settings.max_interior_points,
    )
    LOGGER.info(
        "request_id=%s inference_flow=mesh mesh_file=%s quality=%s boundary=%d interior=%d",
        request_id,
        mesh_file.filename,
        validation.quality,
        validation.boundary_count,
        validation.interior_count,
    )

    preprocessed = preprocess_mesh_inference(
        mesh_request,
        mesh_bytes=mesh_file.content,
        filename=mesh_file.filename,
        rng=np.random.default_rng(0),
    )
    runtime = get_inference_runtime(
        str(settings.model_path),
        settings.device_preference,
        settings.allow_fallback_model,
        settings.inference_engine,
        str(settings.onnx_model_path),
    )
    prediction = run_inference(
        load=preprocessed.load,
        pc=preprocessed.pc,
        xyt=preprocessed.xyt,
        model=runtime.model,
        device=runtime.device,
        engine=runtime.engine,
    )
    compute_time_ms = compute_elapsed_time_ms(started_at)
    ensure_within_timeout(compute_time_ms, settings.inference_timeout_seconds)

    LOGGER.info(
        "request_id=%s inference_flow=mesh completed_ms=%.1f positions=%d",
        request_id,
        compute_time_ms,
        len(preprocessed.positions_world),
    )

    # Generate visualization
    visualization_path = None
    inference_id = f"ginot_{uuid.uuid4().hex[:8]}"

    try:
        visualization_path = generate_pressure_velocity_visualization(
            positions=preprocessed.positions_world,
            velocities=prediction.velocities,
            pressure=prediction.pressure,
            speed=prediction.speed,
            inference_id=inference_id,
        )
    except Exception as exc:
        LOGGER.warning("request_id=%s failed to generate visualization: %s", request_id, exc)

    return build_inference_response(
        positions=preprocessed.positions_world,
        prediction=prediction,
        bounds=build_bounds_from_points(
            np.stack([preprocessed.mesh.bounds_min, preprocessed.mesh.bounds_max], axis=0)
        ),
        metadata=build_response_metadata(
            inlet_center=preprocessed.diffusers.inlet_center_world,
            outlet_center=preprocessed.diffusers.outlet_center_world,
            inlet_velocity=preprocessed.diffusers.inlet_velocity_world,
            boundary_count=preprocessed.sampling.boundary_count,
            interior_count=preprocessed.sampling.interior_count,
            quality=preprocessed.sampling.quality,
            supply_diffuser_ids=preprocessed.diffusers.supply_diffuser_ids,
            return_diffuser_ids=preprocessed.diffusers.return_diffuser_ids,
            model_source=runtime.source,
        ),
        compute_time_ms=compute_time_ms,
        visualization_path=visualization_path,
        inference_id=inference_id,
        grid=preprocessed.grid,
    )
