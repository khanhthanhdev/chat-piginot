from __future__ import annotations

import base64

import numpy as np

from ..schemas import (
    BatchCandidate,
    BatchCandidateResult,
    BatchModelIdentity,
    HvacInferenceBatchRequest,
    HvacInferenceBatchResponse,
)


MODEL = BatchModelIdentity(
    id="piginot-six-terminal",
    version="1",
    source="independent-terminal-adapter",
)


def execute_batch_inference(request: HvacInferenceBatchRequest) -> HvacInferenceBatchResponse:
    _validate_request(request)
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
    for candidate in request.candidates:
        ids = [terminal.id for terminal in candidate.terminals]
        if len(ids) != len(set(ids)):
            raise ValueError(f"Candidate '{candidate.id}' contains duplicate terminal IDs")


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
