from __future__ import annotations

import re
import struct
from dataclasses import dataclass
from pathlib import Path

import numpy as np


SUPPORTED_MESH_EXTENSIONS = {".stl", ".obj"}
_BINARY_STL_HEADER_BYTES = 84
_BINARY_STL_FACE_BYTES = 50
_RAY_DIRECTION = np.asarray([0.81373346, 0.34299717, 0.46941897], dtype=np.float32)
_EPSILON = 1e-6


@dataclass(frozen=True)
class MeshData:
    triangles: np.ndarray
    bounds_min: np.ndarray
    bounds_max: np.ndarray

    @property
    def center(self) -> np.ndarray:
        return (self.bounds_min + self.bounds_max) * 0.5

    @property
    def scale(self) -> float:
        extent = self.bounds_max - self.bounds_min
        return float(np.max(extent))


def load_mesh(mesh_bytes: bytes, filename: str) -> MeshData:
    extension = Path(filename).suffix.lower()
    if extension not in SUPPORTED_MESH_EXTENSIONS:
        supported = ", ".join(sorted(SUPPORTED_MESH_EXTENSIONS))
        raise ValueError(f"Unsupported mesh format '{extension or '<none>'}'. Supported formats: {supported}")

    if extension == ".obj":
        triangles = _load_obj(mesh_bytes)
    else:
        triangles = _load_stl(mesh_bytes)

    return _build_mesh_data(triangles)


def normalize_mesh(mesh: MeshData) -> MeshData:
    scale = mesh.scale
    if scale <= 0:
        raise ValueError("Mesh scale must be positive")

    center = mesh.center.astype(np.float32, copy=False)
    triangles = normalize_points(mesh.triangles, center, scale)
    return _build_mesh_data(triangles)


def sample_surface_points(mesh: MeshData, count: int, rng: np.random.Generator) -> np.ndarray:
    if count < 1:
        raise ValueError("Boundary point count must be at least 1")

    triangles = mesh.triangles
    edges_1 = triangles[:, 1] - triangles[:, 0]
    edges_2 = triangles[:, 2] - triangles[:, 0]
    areas = np.linalg.norm(np.cross(edges_1, edges_2), axis=1) * 0.5
    total_area = float(np.sum(areas))
    if not np.isfinite(total_area) or total_area <= 0:
        raise ValueError("Mesh surface area must be positive")

    probabilities = areas / total_area
    triangle_indices = rng.choice(len(triangles), size=count, replace=True, p=probabilities)
    selected = triangles[triangle_indices]

    r1 = rng.random(count, dtype=np.float32)
    r2 = rng.random(count, dtype=np.float32)
    sqrt_r1 = np.sqrt(r1)
    weights_a = 1.0 - sqrt_r1
    weights_b = sqrt_r1 * (1.0 - r2)
    weights_c = sqrt_r1 * r2

    return (
        selected[:, 0] * weights_a[:, None]
        + selected[:, 1] * weights_b[:, None]
        + selected[:, 2] * weights_c[:, None]
    ).astype(np.float32, copy=False)


def sample_interior_points(
    mesh: MeshData,
    count: int,
    rng: np.random.Generator,
    *,
    max_attempts: int = 24,
    oversample_factor: int = 5,
) -> np.ndarray:
    if count < 1:
        raise ValueError("Interior point count must be at least 1")

    accepted_batches: list[np.ndarray] = []
    accepted_count = 0

    for _ in range(max_attempts):
        remaining = count - accepted_count
        if remaining <= 0:
            break

        candidate_count = max(remaining * oversample_factor, remaining)
        candidates = rng.uniform(
            low=mesh.bounds_min,
            high=mesh.bounds_max,
            size=(candidate_count, 3),
        ).astype(np.float32, copy=False)

        inside_mask = points_inside_mesh(candidates, mesh.triangles)
        if not np.any(inside_mask):
            continue

        accepted = candidates[inside_mask]
        accepted_batches.append(accepted)
        accepted_count += int(accepted.shape[0])

    if accepted_count < count:
        raise ValueError(
            "Failed to sample enough interior points from the mesh. "
            "Check that the mesh is watertight and encloses volume."
        )

    return np.concatenate(accepted_batches, axis=0)[:count].astype(np.float32, copy=False)


def denormalize_points(points: np.ndarray, center: np.ndarray, scale: float) -> np.ndarray:
    return (points * np.float32(scale) + center.astype(np.float32, copy=False)).astype(np.float32, copy=False)


def normalize_points(points: np.ndarray, center: np.ndarray, scale: float) -> np.ndarray:
    scale_value = np.float32(scale)
    if scale_value <= 0:
        raise ValueError("Normalization scale must be positive")
    return ((np.asarray(points, dtype=np.float32) - center.astype(np.float32, copy=False)) / scale_value).astype(
        np.float32,
        copy=False,
    )


def points_inside_mesh(
    points: np.ndarray,
    triangles: np.ndarray,
    *,
    point_batch_size: int = 256,
    triangle_batch_size: int = 2048,
) -> np.ndarray:
    points = np.asarray(points, dtype=np.float32)
    triangles = np.asarray(triangles, dtype=np.float32)

    counts = np.zeros(points.shape[0], dtype=np.int32)
    direction = _RAY_DIRECTION

    for point_start in range(0, points.shape[0], point_batch_size):
        point_end = min(point_start + point_batch_size, points.shape[0])
        point_batch = points[point_start:point_end]
        batch_counts = np.zeros(point_batch.shape[0], dtype=np.int32)

        for triangle_start in range(0, triangles.shape[0], triangle_batch_size):
            triangle_end = min(triangle_start + triangle_batch_size, triangles.shape[0])
            triangle_batch = triangles[triangle_start:triangle_end]

            v0 = triangle_batch[:, 0]
            v1 = triangle_batch[:, 1]
            v2 = triangle_batch[:, 2]
            edge_1 = v1 - v0
            edge_2 = v2 - v0

            h = np.cross(direction[None, :], edge_2)
            a = np.einsum("ij,ij->i", edge_1, h)
            valid = np.abs(a) > _EPSILON
            if not np.any(valid):
                continue

            f = np.zeros_like(a)
            f[valid] = 1.0 / a[valid]

            s = point_batch[:, None, :] - v0[None, :, :]
            u = f[None, :] * np.einsum("ptj,tj->pt", s, h)
            q = np.cross(s, edge_1[None, :, :])
            v = f[None, :] * np.einsum("j,ptj->pt", direction, q)
            t = f[None, :] * np.einsum("tj,ptj->pt", edge_2, q)

            hits = (
                valid[None, :]
                & (u >= -_EPSILON)
                & (v >= -_EPSILON)
                & ((u + v) <= 1.0 + _EPSILON)
                & (t > _EPSILON)
            )
            batch_counts += hits.sum(axis=1, dtype=np.int32)

        counts[point_start:point_end] = batch_counts

    return (counts % 2) == 1


def _build_mesh_data(triangles: np.ndarray) -> MeshData:
    triangles = np.asarray(triangles, dtype=np.float32)
    if triangles.ndim != 3 or triangles.shape[1:] != (3, 3):
        raise ValueError(f"Mesh triangles must have shape [N, 3, 3], got {triangles.shape}")
    if triangles.shape[0] == 0:
        raise ValueError("Mesh must contain at least one triangle")
    if not np.all(np.isfinite(triangles)):
        raise ValueError("Mesh contains NaN or Infinity")

    bounds_min = triangles.reshape(-1, 3).min(axis=0).astype(np.float32, copy=False)
    bounds_max = triangles.reshape(-1, 3).max(axis=0).astype(np.float32, copy=False)
    if not np.all(bounds_max > bounds_min):
        raise ValueError("Mesh bounds are degenerate")

    return MeshData(triangles=triangles, bounds_min=bounds_min, bounds_max=bounds_max)


def _load_stl(mesh_bytes: bytes) -> np.ndarray:
    if _looks_like_binary_stl(mesh_bytes):
        return _load_binary_stl(mesh_bytes)
    return _load_ascii_stl(mesh_bytes)


def _looks_like_binary_stl(mesh_bytes: bytes) -> bool:
    if len(mesh_bytes) < _BINARY_STL_HEADER_BYTES:
        return False
    triangle_count = struct.unpack_from("<I", mesh_bytes, 80)[0]
    expected_size = _BINARY_STL_HEADER_BYTES + triangle_count * _BINARY_STL_FACE_BYTES
    if expected_size == len(mesh_bytes):
        return True
    stripped = mesh_bytes[:5].lstrip().lower()
    return stripped != b"solid"


def _load_binary_stl(mesh_bytes: bytes) -> np.ndarray:
    if len(mesh_bytes) < _BINARY_STL_HEADER_BYTES:
        raise ValueError("Binary STL payload is too short")

    triangle_count = struct.unpack_from("<I", mesh_bytes, 80)[0]
    expected_size = _BINARY_STL_HEADER_BYTES + triangle_count * _BINARY_STL_FACE_BYTES
    if expected_size != len(mesh_bytes):
        raise ValueError("Binary STL payload size does not match triangle count")

    triangles = np.empty((triangle_count, 3, 3), dtype=np.float32)
    offset = _BINARY_STL_HEADER_BYTES

    for index in range(triangle_count):
        offset += 12
        vertices = struct.unpack_from("<9f", mesh_bytes, offset)
        triangles[index] = np.asarray(vertices, dtype=np.float32).reshape(3, 3)
        offset += 36
        offset += 2

    return triangles


def _load_ascii_stl(mesh_bytes: bytes) -> np.ndarray:
    text = mesh_bytes.decode("utf-8", errors="ignore")
    matches = re.findall(
        r"vertex\s+([-+0-9eE\.]+)\s+([-+0-9eE\.]+)\s+([-+0-9eE\.]+)",
        text,
        flags=re.IGNORECASE,
    )
    if len(matches) < 3 or len(matches) % 3 != 0:
        raise ValueError("ASCII STL must contain vertex triplets")

    vertices = np.asarray(matches, dtype=np.float32).reshape(-1, 3, 3)
    return vertices


def _load_obj(mesh_bytes: bytes) -> np.ndarray:
    text = mesh_bytes.decode("utf-8", errors="ignore")
    vertices: list[list[float]] = []
    triangles: list[np.ndarray] = []

    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue

        if line.startswith("v "):
            parts = line.split()
            if len(parts) < 4:
                raise ValueError("OBJ vertex lines must contain 3 coordinates")
            vertices.append([float(parts[1]), float(parts[2]), float(parts[3])])
            continue

        if line.startswith("f "):
            if not vertices:
                raise ValueError("OBJ faces require vertices to be defined first")
            indices = []
            for token in line.split()[1:]:
                vertex_token = token.split("/")[0]
                index = int(vertex_token)
                if index == 0:
                    raise ValueError("OBJ indices are 1-based")
                if index < 0:
                    index = len(vertices) + index
                else:
                    index -= 1
                if index < 0 or index >= len(vertices):
                    raise ValueError("OBJ face index is out of bounds")
                indices.append(index)

            if len(indices) < 3:
                raise ValueError("OBJ faces must contain at least 3 vertices")

            anchor = np.asarray(vertices[indices[0]], dtype=np.float32)
            for idx in range(1, len(indices) - 1):
                triangles.append(
                    np.asarray(
                        [
                            anchor,
                            vertices[indices[idx]],
                            vertices[indices[idx + 1]],
                        ],
                        dtype=np.float32,
                    )
                )

    if not triangles:
        raise ValueError("OBJ mesh must contain at least one face")

    return np.stack(triangles, axis=0).astype(np.float32, copy=False)
