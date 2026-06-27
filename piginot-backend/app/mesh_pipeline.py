from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import torch

from .mesh import MeshData, denormalize_points, load_mesh, normalize_mesh, normalize_points, points_inside_mesh, sample_interior_points, sample_surface_points
from .schemas import DiffuserInput, MeshInferenceOptions, MeshInferenceRequest


QUALITY_PRESETS: dict[str, tuple[int, int]] = {
    "preview": (1000, 1000),
    "standard": (5000, 5000),
    "high": (20000, 12000),
}


@dataclass(frozen=True)
class ResolvedSamplingOptions:
    quality: str
    boundary_count: int
    interior_count: int


@dataclass(frozen=True)
class ResolvedDiffusers:
    inlet_center_world: np.ndarray
    outlet_center_world: np.ndarray
    inlet_velocity_world: np.ndarray
    supply_diffuser_ids: list[str]
    return_diffuser_ids: list[str]


@dataclass(frozen=True)
class MeshInferenceInputs:
    mesh: MeshData
    load: torch.Tensor
    pc: torch.Tensor
    xyt: torch.Tensor
    positions_world: np.ndarray
    sampling: ResolvedSamplingOptions
    diffusers: ResolvedDiffusers
    grid: dict | None


def sample_regular_grid(mesh: MeshData, target_count: int) -> tuple[np.ndarray, dict]:
    extent = mesh.bounds_max - mesh.bounds_min
    scale = (target_count / float(np.prod(extent))) ** (1 / 3)
    dimensions = np.maximum(2, np.floor(extent * scale).astype(int))
    while int(np.prod(dimensions)) > target_count * 2:
        # Only shrink axes that stay >= 2; stop if none can be reduced further.
        reducible = np.where(dimensions > 2, dimensions, -1)
        if int(reducible.max()) <= 2:
            break
        dimensions[int(np.argmax(reducible))] -= 1
    spacing = extent / dimensions
    axes = [
        mesh.bounds_min[i] + spacing[i] * (np.arange(dimensions[i], dtype=np.float32) + 0.5)
        for i in range(3)
    ]
    dense = np.stack(np.meshgrid(*axes, indexing="ij"), axis=-1).reshape(-1, 3)
    mask = points_inside_mesh(dense, mesh.triangles)
    indices = np.flatnonzero(mask)
    if not len(indices):
        raise ValueError("Regular grid contains no points inside mesh")
    return dense[mask], {
        "dimensions": tuple(int(v) for v in dimensions),
        "origin": tuple(float(v) for v in (mesh.bounds_min + spacing * 0.5)),
        "spacing": tuple(float(v) for v in spacing),
        "indices": indices.tolist(),
    }


def resolve_sampling_options(options: MeshInferenceOptions | None) -> ResolvedSamplingOptions:
    quality = options.quality if options is not None else "standard"
    default_boundary_count, default_interior_count = QUALITY_PRESETS[quality]
    boundary_count = options.boundaryCount if options and options.boundaryCount is not None else default_boundary_count
    interior_count = options.interiorCount if options and options.interiorCount is not None else default_interior_count
    return ResolvedSamplingOptions(
        quality=quality,
        boundary_count=int(boundary_count),
        interior_count=int(interior_count),
    )


def preprocess_mesh_inference(
    request: MeshInferenceRequest,
    *,
    mesh_bytes: bytes,
    filename: str,
    rng: np.random.Generator,
) -> MeshInferenceInputs:
    mesh = load_mesh(mesh_bytes, filename)
    mesh_norm = normalize_mesh(mesh)
    sampling = resolve_sampling_options(request.options)
    diffusers = collapse_diffusers(request.diffusers)

    pc_points = sample_surface_points(mesh_norm, sampling.boundary_count, rng)
    grid = None
    if request.options.returnGrid3D:
        positions_world, grid = sample_regular_grid(mesh, sampling.interior_count)
        xyt_points = normalize_points(positions_world, mesh.center, mesh.scale)
    else:
        xyt_points = sample_interior_points(mesh_norm, sampling.interior_count, rng)
        positions_world = denormalize_points(xyt_points, mesh.center, mesh.scale)

    inlet_center_normalized = normalize_points(diffusers.inlet_center_world[None, :], mesh.center, mesh.scale)[0]
    outlet_center_normalized = normalize_points(diffusers.outlet_center_world[None, :], mesh.center, mesh.scale)[0]
    load_vector = np.concatenate(
        [inlet_center_normalized, outlet_center_normalized, diffusers.inlet_velocity_world.astype(np.float32, copy=False)],
        axis=0,
    ).astype(np.float32, copy=False)

    return MeshInferenceInputs(
        mesh=mesh,
        load=torch.from_numpy(load_vector).unsqueeze(0),
        pc=torch.from_numpy(pc_points).unsqueeze(0),
        xyt=torch.from_numpy(xyt_points).unsqueeze(0),
        positions_world=positions_world,
        sampling=sampling,
        diffusers=diffusers,
        grid=grid,
    )


def collapse_diffusers(diffusers: list[DiffuserInput]) -> ResolvedDiffusers:
    supply_diffusers = [diffuser for diffuser in diffusers if diffuser.kind == "supply"]
    return_diffusers = [diffuser for diffuser in diffusers if diffuser.kind == "return"]

    if not supply_diffusers:
        raise ValueError("At least one supply diffuser is required")
    if not return_diffusers:
        raise ValueError("At least one return diffuser is required")

    supply_weights = np.asarray([_diffuser_weight(diffuser) for diffuser in supply_diffusers], dtype=np.float32)
    return_weights = np.asarray([_diffuser_weight(diffuser) for diffuser in return_diffusers], dtype=np.float32)

    inlet_center_world = _weighted_average(
        [np.asarray(diffuser.center, dtype=np.float32) for diffuser in supply_diffusers],
        supply_weights,
    )
    outlet_center_world = _weighted_average(
        [np.asarray(diffuser.center, dtype=np.float32) for diffuser in return_diffusers],
        return_weights,
    )

    inlet_velocity_vectors: list[np.ndarray] = []
    inlet_velocity_weights: list[float] = []
    for diffuser in supply_diffusers:
        if diffuser.direction is None:
            continue
        velocity = _supply_velocity_vector(diffuser)
        inlet_velocity_vectors.append(velocity)
        inlet_velocity_weights.append(float(np.linalg.norm(velocity)))

    if not inlet_velocity_vectors:
        raise ValueError("At least one supply diffuser must define a non-zero direction")

    inlet_velocity_world = _weighted_average(inlet_velocity_vectors, np.asarray(inlet_velocity_weights, dtype=np.float32))
    if float(np.linalg.norm(inlet_velocity_world)) <= 0:
        raise ValueError("Supply diffuser directions collapse to a zero inlet velocity")

    return ResolvedDiffusers(
        inlet_center_world=inlet_center_world,
        outlet_center_world=outlet_center_world,
        inlet_velocity_world=inlet_velocity_world,
        supply_diffuser_ids=[diffuser.id for diffuser in supply_diffusers],
        return_diffuser_ids=[diffuser.id for diffuser in return_diffusers],
    )


def _diffuser_weight(diffuser: DiffuserInput) -> float:
    if diffuser.airflowRate is not None:
        return float(diffuser.airflowRate)
    if diffuser.kind == "supply" and diffuser.direction is not None:
        return float(np.linalg.norm(np.asarray(diffuser.direction, dtype=np.float32)))
    return 1.0


def _supply_velocity_vector(diffuser: DiffuserInput) -> np.ndarray:
    if diffuser.direction is None:
        raise ValueError("Supply diffuser direction is required to derive inlet velocity")

    direction = np.asarray(diffuser.direction, dtype=np.float32)
    magnitude = float(np.linalg.norm(direction))
    if magnitude <= 0:
        raise ValueError(f"Supply diffuser '{diffuser.id}' direction must be non-zero")

    if diffuser.airflowRate is not None:
        return (direction / np.float32(magnitude) * np.float32(diffuser.airflowRate)).astype(np.float32, copy=False)

    return direction.astype(np.float32, copy=False)


def _weighted_average(values: list[np.ndarray], weights: np.ndarray) -> np.ndarray:
    stacked = np.stack(values, axis=0).astype(np.float32, copy=False)
    weight_sum = float(np.sum(weights))
    if weight_sum <= 0:
        raise ValueError("Diffuser weights must sum to a positive value")
    normalized_weights = (weights / np.float32(weight_sum)).astype(np.float32, copy=False)
    return np.sum(stacked * normalized_weights[:, None], axis=0).astype(np.float32, copy=False)
