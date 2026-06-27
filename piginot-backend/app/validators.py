from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import torch

from .mesh import SUPPORTED_MESH_EXTENSIONS
from .mesh_pipeline import resolve_sampling_options
from .schemas import GinotInferenceRequest, MeshInferenceRequest


@dataclass(frozen=True)
class RequestPointCounts:
    boundary_count: int
    interior_count: int


@dataclass(frozen=True)
class MeshRequestValidation:
    boundary_count: int
    interior_count: int
    quality: str


def validate_request(
    request: GinotInferenceRequest,
    *,
    max_boundary_points: int | None = None,
    max_interior_points: int | None = None,
) -> RequestPointCounts:
    errors = []

    if len(request.load) != 9:
        errors.append(f"Load vector must have 9 elements, got {len(request.load)}")

    if len(request.pc) % 3 != 0:
        errors.append(f"PC length must be divisible by 3, got {len(request.pc)}")

    if len(request.xyt) % 3 != 0:
        errors.append(f"XYT length must be divisible by 3, got {len(request.xyt)}")

    if not np.all(np.isfinite(request.load)):
        errors.append("Load vector contains NaN or Infinity")
    if not np.all(np.isfinite(request.pc)):
        errors.append("PC contains NaN or Infinity")
    if not np.all(np.isfinite(request.xyt)):
        errors.append("XYT contains NaN or Infinity")

    boundary_count = len(request.pc) // 3
    interior_count = len(request.xyt) // 3

    if boundary_count < 100:
        errors.append(f"Too few boundary points: {boundary_count} (minimum 100)")
    if interior_count < 1:
        errors.append("No interior query points")

    if len(request.load) == 9:
        for i in range(6):
            if abs(request.load[i]) > 10:
                errors.append(f"Load[{i}] = {request.load[i]} outside normalized range")

        for i in range(6, 9):
            if request.load[i] < -50 or request.load[i] > 50:
                errors.append(f"Load[{i}] = {request.load[i]} invalid velocity")

    if max_boundary_points is not None and boundary_count > max_boundary_points:
        errors.append(
            f"Too many boundary points: {boundary_count} (maximum {max_boundary_points})"
        )
    if max_interior_points is not None and interior_count > max_interior_points:
        errors.append(
            f"Too many interior query points: {interior_count} (maximum {max_interior_points})"
        )

    if request.metadata is not None:
        if request.metadata.boundaryCount is not None and request.metadata.boundaryCount != boundary_count:
            errors.append(
                f"metadata.boundaryCount={request.metadata.boundaryCount} does not match payload ({boundary_count})"
            )
        if request.metadata.interiorCount is not None and request.metadata.interiorCount != interior_count:
            errors.append(
                f"metadata.interiorCount={request.metadata.interiorCount} does not match payload ({interior_count})"
            )
        if request.metadata.center is not None and len(request.metadata.center) != 3:
            errors.append("metadata.center must contain exactly 3 values")
        if request.metadata.scale is not None and request.metadata.scale <= 0:
            errors.append("metadata.scale must be positive")

    if errors:
        raise ValueError("; ".join(errors))

    return RequestPointCounts(
        boundary_count=boundary_count,
        interior_count=interior_count,
    )


def build_model_inputs(request: GinotInferenceRequest) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    load = torch.tensor(request.load, dtype=torch.float32).unsqueeze(0)
    pc_array = np.asarray(request.pc, dtype=np.float32).reshape(-1, 3)
    xyt_array = np.asarray(request.xyt, dtype=np.float32).reshape(-1, 3)
    pc = torch.from_numpy(pc_array).unsqueeze(0)
    xyt = torch.from_numpy(xyt_array).unsqueeze(0)
    return load, pc, xyt


def reshape_tensors(request: GinotInferenceRequest) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    return build_model_inputs(request)


def validate_mesh_request(
    request: MeshInferenceRequest,
    *,
    filename: str,
    max_boundary_points: int | None = None,
    max_interior_points: int | None = None,
) -> MeshRequestValidation:
    errors = []
    resolved_sampling = resolve_sampling_options(request.options)

    supported_extensions = ", ".join(sorted(SUPPORTED_MESH_EXTENSIONS))
    if not any(filename.lower().endswith(extension) for extension in SUPPORTED_MESH_EXTENSIONS):
        errors.append(
            f"Unsupported mesh file '{filename}'. Supported formats: {supported_extensions}"
        )

    diffuser_ids: set[str] = set()
    supply_count = 0
    return_count = 0
    supply_with_direction = 0

    for diffuser in request.diffusers:
        if diffuser.id in diffuser_ids:
            errors.append(f"Duplicate diffuser id '{diffuser.id}'")
        diffuser_ids.add(diffuser.id)

        center = np.asarray(diffuser.center, dtype=np.float32)
        if center.shape != (3,) or not np.all(np.isfinite(center)):
            errors.append(f"Diffuser '{diffuser.id}' center must contain 3 finite values")

        if diffuser.direction is not None:
            direction = np.asarray(diffuser.direction, dtype=np.float32)
            if direction.shape != (3,) or not np.all(np.isfinite(direction)):
                errors.append(f"Diffuser '{diffuser.id}' direction must contain 3 finite values")
            elif float(np.linalg.norm(direction)) <= 0:
                errors.append(f"Diffuser '{diffuser.id}' direction must be non-zero")

        if diffuser.airflowRate is not None and not np.isfinite(diffuser.airflowRate):
            errors.append(f"Diffuser '{diffuser.id}' airflowRate must be finite")

        if diffuser.kind == "supply":
            supply_count += 1
            if diffuser.direction is not None and float(np.linalg.norm(np.asarray(diffuser.direction, dtype=np.float32))) > 0:
                supply_with_direction += 1
        elif diffuser.kind == "return":
            return_count += 1

    if supply_count < 1:
        errors.append("At least one supply diffuser is required")
    if return_count < 1:
        errors.append("At least one return diffuser is required")
    if supply_with_direction < 1:
        errors.append("At least one supply diffuser must define a non-zero direction")

    if resolved_sampling.boundary_count < 100:
        errors.append(f"Too few boundary points: {resolved_sampling.boundary_count} (minimum 100)")
    if resolved_sampling.interior_count < 1:
        errors.append("No interior query points")

    if max_boundary_points is not None and resolved_sampling.boundary_count > max_boundary_points:
        errors.append(
            f"Too many boundary points: {resolved_sampling.boundary_count} (maximum {max_boundary_points})"
        )
    if max_interior_points is not None and resolved_sampling.interior_count > max_interior_points:
        errors.append(
            f"Too many interior query points: {resolved_sampling.interior_count} (maximum {max_interior_points})"
        )

    if errors:
        raise ValueError("; ".join(errors))

    return MeshRequestValidation(
        boundary_count=resolved_sampling.boundary_count,
        interior_count=resolved_sampling.interior_count,
        quality=resolved_sampling.quality,
    )
