from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class MetadataInput(BaseModel):
    """Metadata for normalizing request coordinates."""

    boundaryCount: int | None = Field(
        default=None,
        ge=1,
        description="Number of boundary points in the point cloud (N)",
    )
    interiorCount: int | None = Field(
        default=None,
        ge=1,
        description="Number of interior query points (M)",
    )
    center: list[float] | None = Field(
        default=None,
        min_length=3,
        max_length=3,
        description="Center point [x, y, z] used for normalization. Used to denormalize results to world space.",
    )
    scale: float | None = Field(
        default=None,
        gt=0,
        description="Scale factor used for normalization. Used to denormalize results to world space.",
    )


class GinotInferenceRequest(BaseModel):
    """Request payload for direct CFD inference without mesh preprocessing."""

    load: list[float] = Field(
        ...,
        min_length=9,
        max_length=9,
        description="9-element load vector representing HVAC boundary conditions (e.g., inlet/outlet pressures and velocities).",
    )
    pc: list[float] = Field(
        ...,
        description="Flattened boundary point cloud as [x1, y1, z1, x2, y2, z2, ...]. "
        "Represents N boundary points: N = len(pc) / 3. Points should be on or near the domain boundary.",
    )
    xyt: list[float] = Field(
        ...,
        description="Flattened interior query points as [x1, y1, z1, x2, y2, z2, ...]. "
        "Represents M query points: M = len(xyt) / 3. Where CFD results will be evaluated.",
    )
    metadata: MetadataInput | None = Field(
        default=None,
        description="Optional normalization metadata. Provide center and scale if coordinates are in normalized space.",
    )


class DiffuserInput(BaseModel):
    """Configuration for a supply or return diffuser in the domain."""

    id: str = Field(
        ...,
        min_length=1,
        description="Unique identifier for the diffuser.",
    )
    kind: Literal["supply", "return"] = Field(
        ...,
        description="Type of diffuser. 'supply' for inlet, 'return' for outlet.",
    )
    center: list[float] = Field(
        ...,
        min_length=3,
        max_length=3,
        description="Center location of the diffuser [x, y, z] in world coordinates.",
    )
    direction: list[float] | None = Field(
        default=None,
        min_length=3,
        max_length=3,
        description="Direction vector [dx, dy, dz] for flow orientation. Normalized internally.",
    )
    airflowRate: float | None = Field(
        default=None,
        gt=0,
        description=(
            "Optional inlet speed magnitude in m/s. "
            "If omitted for a supply diffuser, the direction vector magnitude is used."
        ),
    )


class MeshInferenceOptions(BaseModel):
    """Options controlling mesh preprocessing and sampling behavior."""

    quality: Literal["preview", "standard", "high"] = Field(
        default="standard",
        description="Mesh sampling quality level affecting point density. "
        "'preview': lower density, faster; 'standard': balanced; 'high': higher density, slower.",
    )
    boundaryCount: int | None = Field(
        default=None,
        ge=100,
        description="Target number of boundary points to sample from mesh surface. "
        "If None, uses quality-based defaults.",
    )
    interiorCount: int | None = Field(
        default=None,
        ge=1,
        description="Target number of interior query points to sample within domain. "
        "If None, uses quality-based defaults.",
    )
    returnGrid3D: bool = Field(
        default=False,
        description="If true, return results as a 3D grid. Otherwise returns point cloud results.",
    )


class MeshInferenceContext(BaseModel):
    """Optional context metadata for request tracking and organization."""

    projectId: str | None = Field(
        default=None,
        description="Project identifier for tracking across multiple requests.",
    )
    levelId: str | None = Field(
        default=None,
        description="Level or floor identifier within a project.",
    )
    zoneId: str | None = Field(
        default=None,
        description="Zone or room identifier for localized analysis.",
    )


class MeshInferenceRequest(BaseModel):
    """Request payload for mesh-based CFD inference."""

    diffusers: list[DiffuserInput] = Field(
        ...,
        min_length=2,
        description="List of supply and/or return diffusers. Minimum 2 diffusers required (e.g., 1 supply + 1 return).",
    )
    options: MeshInferenceOptions = Field(
        default_factory=MeshInferenceOptions,
        description="Mesh sampling and quality options.",
    )
    context: MeshInferenceContext | None = Field(
        default=None,
        description="Optional metadata for request tracking.",
    )


class Bounds(BaseModel):
    """Spatial bounds of the domain."""

    min: list[float] = Field(
        ...,
        min_length=3,
        max_length=3,
        description="Minimum corner of bounding box [x_min, y_min, z_min].",
    )
    max: list[float] = Field(
        ...,
        min_length=3,
        max_length=3,
        description="Maximum corner of bounding box [x_max, y_max, z_max].",
    )


class ResponseMetadata(BaseModel):
    """Metadata about the CFD simulation and domain configuration."""

    inletCenter: list[float] = Field(
        ...,
        min_length=3,
        max_length=3,
        description="Center location of supply/inlet diffuser [x, y, z].",
    )
    outletCenter: list[float] = Field(
        ...,
        min_length=3,
        max_length=3,
        description="Center location of return/outlet diffuser [x, y, z].",
    )
    inletVelocity: list[float] = Field(
        ...,
        min_length=3,
        max_length=3,
        description="Inlet velocity vector [vx, vy, vz] used in the simulation.",
    )
    boundaryCount: int | None = Field(
        default=None,
        ge=1,
        description="Number of boundary points sampled from domain surface.",
    )
    interiorCount: int | None = Field(
        default=None,
        ge=1,
        description="Number of interior query points evaluated.",
    )
    quality: str | None = Field(
        default=None,
        description="Mesh sampling quality level used (preview/standard/high).",
    )
    supplyDiffuserIds: list[str] | None = Field(
        default=None,
        description="List of supply diffuser IDs processed in this request.",
    )
    returnDiffuserIds: list[str] | None = Field(
        default=None,
        description="List of return diffuser IDs processed in this request.",
    )
    modelSource: str | None = Field(
        default=None,
        description="Source of the model used for inference (e.g., 'checkpoint', 'fallback').",
    )

class Grid3D(BaseModel):
    dimensions: tuple[int, int, int]
    origin: tuple[float, float, float]
    spacing: tuple[float, float, float]
    indices: list[int]


class GinotInferenceResponse(BaseModel):
    """Response payload containing CFD simulation results."""

    positions: list[list[float]] = Field(
        ...,
        description="Coordinates of evaluated query points [M][3], where M is the number of interior points.",
    )
    velocities: list[list[float]] = Field(
        ...,
        description="Velocity vectors at each query point [M][3]. Each entry is [vx, vy, vz].",
    )
    pressure: list[float] = Field(
        ...,
        description="Static pressure at each query point [M].",
    )
    speed: list[float] = Field(
        ...,
        description="Velocity magnitude (speed) at each query point [M]. Magnitude of velocity vectors.",
    )
    bounds: Bounds = Field(
        ...,
        description="Bounding box of the domain.",
    )
    metadata: ResponseMetadata = Field(
        ...,
        description="Simulation configuration and diffuser information.",
    )
    inferenceId: str = Field(
        ...,
        description="Unique identifier for this inference request (e.g., 'ginot_abcd1234').",
    )
    timestamp: int = Field(
        ...,
        description="Unix timestamp in milliseconds when the inference was completed.",
    )
    computeTimeMs: float = Field(
        ...,
        description="Total computation time for the inference in milliseconds.",
    )
    visualizationPath: str | None = Field(
        default=None,
        description="Optional path to the generated visualization image showing pressure and velocity distributions.",
    )
    grid: Grid3D | None = None
