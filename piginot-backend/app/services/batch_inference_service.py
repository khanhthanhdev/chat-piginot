from __future__ import annotations

import base64
import os
from pathlib import Path

import numpy as np
import torch

from ..inference import InferenceRuntime, get_inference_runtime, run_inference
from ..models.ginot import PhysicsNormalization
from ..schemas import (
    BatchCandidate,
    BatchCandidateResult,
    BatchModelIdentity,
    BatchTerminal,
    HvacInferenceBatchRequest,
    HvacInferenceBatchResponse,
)
from ..settings import get_settings


MODEL = BatchModelIdentity(
    id="piginot-analytic-six-terminal",
    version="1",
    source="analytic-test-fixture",
)


def execute_batch_inference(request: HvacInferenceBatchRequest) -> HvacInferenceBatchResponse:
    _validate_request(request)
    settings = get_settings()
    runtime = get_inference_runtime(
        str(settings.model_path),
        settings.device_preference,
        settings.allow_fallback_model,
        settings.inference_engine,
        str(settings.onnx_model_path),
    )
    if runtime.normalization is not None:
        return _execute_model_inference(request, runtime)
    if os.getenv("PIGINOT_ALLOW_SYNTHETIC", "").strip().lower() not in {"1", "true", "yes"}:
        raise ValueError(
            "Synthetic predictions are disabled and the configured checkpoint does not support "
            "independent 3+3 physics-boundary inference"
        )

    points = _grid_points(request)
    results: list[BatchCandidateResult] = []
    for candidate in request.candidates:
        try:
            field = predict_candidate(candidate, points)
            results.append(
                BatchCandidateResult(
                    id=candidate.id,
                    status="succeeded",
                    velocityMagnitudeBase64=base64.b64encode(
                        field.astype("<f4", copy=False).tobytes()
                    ).decode("ascii"),
                )
            )
        except ValueError as exc:
            results.append(BatchCandidateResult(id=candidate.id, status="failed", error=str(exc)))
    return HvacInferenceBatchResponse(model=MODEL, grid=request.grid, candidates=results)


def _execute_model_inference(
    request: HvacInferenceBatchRequest,
    runtime: InferenceRuntime,
) -> HvacInferenceBatchResponse:
    if runtime.normalization is None:
        raise ValueError("Physics-boundary checkpoint normalization is missing")
    normalization = runtime.normalization
    points = _grid_points(request)
    query = _normalize_coordinates(points, normalization).unsqueeze(0)
    walls = _sample_room_walls(request, 3072)
    results: list[BatchCandidateResult] = []
    for candidate in request.candidates:
        try:
            pc = _build_candidate_point_cloud(
                walls,
                candidate,
                normalization,
                point_count=4096,
            ).unsqueeze(0)
            prediction = run_inference(
                load=torch.zeros((1, 9), dtype=torch.float32),
                pc=pc,
                xyt=query,
                model=runtime.model,
                device=runtime.device,
                engine=runtime.engine,
            )
            field = prediction.speed.astype("<f4", copy=False)
            results.append(
                BatchCandidateResult(
                    id=candidate.id,
                    status="succeeded",
                    velocityMagnitudeBase64=base64.b64encode(field.tobytes()).decode("ascii"),
                )
            )
        except (RuntimeError, ValueError) as exc:
            results.append(BatchCandidateResult(id=candidate.id, status="failed", error=str(exc)))

    checkpoint = Path(runtime.checkpoint_path or runtime.source)
    model = BatchModelIdentity(
        id=checkpoint.stem,
        version="1",
        source="checkpoint",
    )
    return HvacInferenceBatchResponse(model=model, grid=request.grid, candidates=results)


def predict_candidate(candidate: BatchCandidate, points: np.ndarray) -> np.ndarray:
    supplies = [terminal for terminal in candidate.terminals if terminal.role == "supply"]
    returns = [terminal for terminal in candidate.terminals if terminal.role == "return"]
    if len(supplies) != 3 or len(returns) != 3:
        raise ValueError("Each candidate must contain exactly three supplies and three returns")

    velocity = np.zeros_like(points, dtype=np.float32)
    for terminal in supplies:
        centre = np.asarray(terminal.centre, dtype=np.float32)
        direction = _unit_direction(terminal.direction, terminal.id)
        delta = points - centre
        distance = np.linalg.norm(delta, axis=1, keepdims=True)
        axial = np.maximum(0.0, delta @ direction).reshape(-1, 1)
        radial = np.linalg.norm(delta - axial * direction, axis=1, keepdims=True)
        strength = terminal.faceVelocity * np.exp(-distance / 2.5) * np.exp(-radial / 1.2)
        velocity += strength.astype(np.float32) * direction

    for terminal in returns:
        centre = np.asarray(terminal.centre, dtype=np.float32)
        delta = centre - points
        distance = np.linalg.norm(delta, axis=1, keepdims=True)
        velocity += (
            terminal.faceVelocity
            * np.exp(-distance / 2.0)
            * delta
            / np.maximum(distance, np.float32(0.05))
        ).astype(np.float32)

    return np.linalg.norm(velocity, axis=1).astype(np.float32)


def _validate_request(request: HvacInferenceBatchRequest) -> None:
    minimum = np.asarray(request.room.minimum, dtype=np.float64)
    maximum = np.asarray(request.room.maximum, dtype=np.float64)
    shape = np.asarray(request.grid.shape)
    spacing = np.asarray(request.grid.spacing, dtype=np.float64)
    if not np.all(np.isfinite([*minimum, *maximum, *spacing])):
        raise ValueError("Room and grid values must be finite")
    if np.any(maximum <= minimum):
        raise ValueError("Room maximum must be greater than minimum")
    if np.any(shape <= 0) or np.any(spacing <= 0):
        raise ValueError("Grid shape and spacing must be positive")
    if int(np.prod(shape, dtype=np.int64)) > get_settings().max_interior_points:
        raise ValueError(
            f"Grid contains more than {get_settings().max_interior_points} interior points"
        )
    for candidate in request.candidates:
        ids = [terminal.id for terminal in candidate.terminals]
        if len(ids) != len(set(ids)):
            raise ValueError(f"Candidate '{candidate.id}' contains duplicate terminal IDs")
        values = [
            value
            for terminal in candidate.terminals
            for value in (
                *terminal.centre,
                *terminal.direction,
                terminal.faceVelocity,
                terminal.width,
                terminal.depth,
                terminal.rotation,
            )
        ]
        if not np.all(np.isfinite(values)):
            raise ValueError(f"Candidate '{candidate.id}' contains non-finite terminal values")


def _grid_points(request: HvacInferenceBatchRequest) -> np.ndarray:
    shape = request.grid.shape
    axes = [
        request.grid.origin[i]
        + request.grid.spacing[i] * np.arange(shape[i], dtype=np.float32)
        for i in range(3)
    ]
    return np.stack(np.meshgrid(*axes, indexing="ij"), axis=-1).reshape(-1, 3)


def _unit_direction(value: tuple[float, float, float], terminal_id: str) -> np.ndarray:
    direction = np.asarray(value, dtype=np.float32)
    magnitude = float(np.linalg.norm(direction))
    if not np.isfinite(magnitude) or magnitude <= 0:
        raise ValueError(f"Terminal '{terminal_id}' direction must be finite and non-zero")
    return direction / np.float32(magnitude)


def _normalize_coordinates(
    points: np.ndarray,
    normalization: PhysicsNormalization,
) -> torch.Tensor:
    coord_min = np.asarray(normalization.coord_min, dtype=np.float32)
    coord_scale = np.asarray(normalization.coord_scale, dtype=np.float32)
    return torch.from_numpy(((points - coord_min) / coord_scale).astype(np.float32, copy=False))


def _sample_room_walls(request: HvacInferenceBatchRequest, point_count: int) -> np.ndarray:
    minimum = np.asarray(request.room.minimum, dtype=np.float32)
    maximum = np.asarray(request.room.maximum, dtype=np.float32)
    extent = maximum - minimum
    face_areas = np.asarray(
        [
            extent[1] * extent[2],
            extent[1] * extent[2],
            extent[0] * extent[2],
            extent[0] * extent[2],
            extent[0] * extent[1],
            extent[0] * extent[1],
        ],
        dtype=np.float64,
    )
    rng = np.random.default_rng(0)
    faces = rng.choice(6, size=point_count, p=face_areas / face_areas.sum())
    points = minimum + rng.random((point_count, 3), dtype=np.float32) * extent
    for axis in range(3):
        points[faces == axis * 2, axis] = minimum[axis]
        points[faces == axis * 2 + 1, axis] = maximum[axis]
    return points


def _build_candidate_point_cloud(
    walls: np.ndarray,
    candidate: BatchCandidate,
    normalization: PhysicsNormalization,
    *,
    point_count: int,
) -> torch.Tensor:
    terminal_count = point_count - len(walls)
    areas = np.asarray(
        [terminal.width * terminal.depth for terminal in candidate.terminals],
        dtype=np.float64,
    )
    allocations = areas / areas.sum() * terminal_count
    counts = np.floor(allocations).astype(np.int64)
    for index in np.argsort(-(allocations - counts))[: terminal_count - int(counts.sum())]:
        counts[index] += 1

    coord_min = np.asarray(normalization.coord_min, dtype=np.float32)
    coord_scale = np.asarray(normalization.coord_scale, dtype=np.float32)
    target_mean = np.asarray(normalization.target_mean, dtype=np.float32)
    target_std = np.asarray(normalization.target_std, dtype=np.float32)
    zero_normalized = -target_mean / target_std

    coordinates = [walls]
    masks = [np.tile(np.asarray([0, 1, 0, 0, 0], dtype=np.float32), (len(walls), 1))]
    wall_targets = np.tile(zero_normalized, (len(walls), 1))
    wall_targets[:, 3] = 0.0
    targets = [wall_targets]

    for terminal, count in zip(candidate.terminals, counts, strict=True):
        coordinates.append(_sample_terminal_surface(terminal, int(count)))
        if terminal.role == "supply":
            masks.append(np.tile([0, 0, 1, 0, 0], (count, 1)))
            velocity = _unit_direction(terminal.direction, terminal.id) * terminal.faceVelocity
            normalized = (np.append(velocity, 0.0) - target_mean) / target_std
            normalized[3] = 0.0
        else:
            masks.append(np.tile([0, 0, 0, 1, 0], (count, 1)))
            normalized = zero_normalized.copy()
            normalized[:3] = 0.0
        targets.append(np.tile(normalized, (count, 1)))

    xyz = (np.concatenate(coordinates) - coord_min) / coord_scale
    pc = np.concatenate([xyz, np.concatenate(masks), np.concatenate(targets)], axis=1)
    pc = pc[np.random.default_rng(0).permutation(len(pc))]
    return torch.from_numpy(pc.astype(np.float32, copy=False))


def _sample_terminal_surface(terminal: BatchTerminal, point_count: int) -> np.ndarray:
    columns = max(1, round(np.sqrt(point_count * terminal.width / terminal.depth)))
    rows = int(np.ceil(point_count / columns))
    u = (np.arange(columns, dtype=np.float32) + 0.5) / columns - 0.5
    v = (np.arange(rows, dtype=np.float32) + 0.5) / rows - 0.5
    uu, vv = np.meshgrid(u, v)
    cosine = np.float32(np.cos(terminal.rotation))
    sine = np.float32(np.sin(terminal.rotation))
    width_axis = np.asarray([cosine, sine, 0.0], dtype=np.float32)
    depth_axis = np.asarray([-sine, cosine, 0.0], dtype=np.float32)
    return (
        np.asarray(terminal.centre, dtype=np.float32)
        + uu.reshape(-1, 1)[:point_count] * terminal.width * width_axis
        + vv.reshape(-1, 1)[:point_count] * terminal.depth * depth_axis
    )
