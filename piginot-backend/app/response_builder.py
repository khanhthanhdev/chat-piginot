from __future__ import annotations

import time
import uuid

import numpy as np

from .inference import InferencePrediction
from .mesh import denormalize_points
from .schemas import Bounds, GinotInferenceResponse, ResponseMetadata


def build_bounds_from_points(points: np.ndarray) -> Bounds:
    return Bounds(
        min=points.min(axis=0).astype(np.float32, copy=False).tolist(),
        max=points.max(axis=0).astype(np.float32, copy=False).tolist(),
    )


def build_inference_response(
    *,
    positions: np.ndarray,
    prediction: InferencePrediction,
    bounds: Bounds,
    metadata: ResponseMetadata,
    compute_time_ms: float,
    visualization_path: str | None = None,
    inference_id: str | None = None,
    grid: dict | None = None,
) -> GinotInferenceResponse:
    if inference_id is None:
        inference_id = f"ginot_{uuid.uuid4().hex[:8]}"
    return GinotInferenceResponse(
        positions=np.asarray(positions, dtype=np.float32).tolist(),
        velocities=prediction.velocities.tolist(),
        pressure=prediction.pressure.tolist(),
        speed=prediction.speed.tolist(),
        bounds=bounds,
        metadata=metadata,
        inferenceId=inference_id,
        timestamp=int(time.time() * 1000),
        computeTimeMs=compute_time_ms,
        visualizationPath=visualization_path,
        grid=grid,
    )


def build_response_metadata(
    *,
    inlet_center: np.ndarray,
    outlet_center: np.ndarray,
    inlet_velocity: np.ndarray,
    boundary_count: int | None = None,
    interior_count: int | None = None,
    quality: str | None = None,
    supply_diffuser_ids: list[str] | None = None,
    return_diffuser_ids: list[str] | None = None,
    model_source: str | None = None,
) -> ResponseMetadata:
    return ResponseMetadata(
        inletCenter=np.asarray(inlet_center, dtype=np.float32).tolist(),
        outletCenter=np.asarray(outlet_center, dtype=np.float32).tolist(),
        inletVelocity=np.asarray(inlet_velocity, dtype=np.float32).tolist(),
        boundaryCount=boundary_count,
        interiorCount=interior_count,
        quality=quality,
        supplyDiffuserIds=supply_diffuser_ids,
        returnDiffuserIds=return_diffuser_ids,
        modelSource=model_source,
    )


def build_response_metadata_from_load(
    load: list[float],
    *,
    center: list[float] | None = None,
    scale: float | None = None,
    boundary_count: int | None = None,
    interior_count: int | None = None,
    quality: str | None = None,
    model_source: str | None = None,
) -> ResponseMetadata:
    inlet_center = np.asarray(load[:3], dtype=np.float32)
    outlet_center = np.asarray(load[3:6], dtype=np.float32)
    inlet_velocity = np.asarray(load[6:9], dtype=np.float32)

    if center is not None and scale is not None:
        center_array = np.asarray(center, dtype=np.float32)
        inlet_center = denormalize_points(inlet_center[None, :], center_array, scale)[0]
        outlet_center = denormalize_points(outlet_center[None, :], center_array, scale)[0]

    return build_response_metadata(
        inlet_center=inlet_center,
        outlet_center=outlet_center,
        inlet_velocity=inlet_velocity,
        boundary_count=boundary_count,
        interior_count=interior_count,
        quality=quality,
        model_source=model_source,
    )
