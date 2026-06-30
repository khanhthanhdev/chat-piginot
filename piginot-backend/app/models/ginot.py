from __future__ import annotations

import json
import math
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import torch
import torch.nn as nn

from .point_encoding import PointCloudPerceiverChannelsEncoder
from .point_position_embedding import PosEmbLinear
from .transformer import ResidualCrossAttentionBlock


@dataclass(frozen=True)
class PhysicsNormalization:
    coord_min: tuple[float, float, float]
    coord_scale: tuple[float, float, float]
    target_mean: tuple[float, float, float, float]
    target_std: tuple[float, float, float, float]

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "PhysicsNormalization":
        fields = {
            "coord_min": (3, False),
            "coord_scale": (3, True),
            "target_mean": (4, False),
            "target_std": (4, True),
        }
        parsed: dict[str, tuple[float, ...]] = {}
        for name, (length, positive) in fields.items():
            values = tuple(float(item) for item in value.get(name, ()))
            if len(values) != length or not all(math.isfinite(item) for item in values):
                raise ValueError(f"Checkpoint normalization '{name}' must contain {length} finite values")
            if positive and not all(item > 0 for item in values):
                raise ValueError(f"Checkpoint normalization '{name}' values must be positive")
            parsed[name] = values
        return cls(**parsed)


class MildFourierEncoder(nn.Module):
    def __init__(
        self,
        in_channels: int = 3,
        base_length: float = 1.0,
        min_length: float = 0.1,
        num_bands: int = 4,
    ) -> None:
        super().__init__()
        frequencies = torch.linspace(
            2 * math.pi / base_length,
            2 * math.pi / min_length,
            steps=num_bands,
        )
        self.register_buffer("freqs", frequencies)
        self.out_channels = in_channels * num_bands * 2

    def forward(self, value: torch.Tensor) -> torch.Tensor:
        scaled = value.unsqueeze(-1) * self.freqs.view(1, 1, 1, -1)
        return torch.cat([torch.sin(scaled), torch.cos(scaled)], dim=-1).flatten(2)


class PhysicsGINOTModel(nn.Module):
    model_type = "physics_boundary_v1"

    def __init__(
        self,
        *,
        branch_args: dict[str, Any] | None = None,
        trunk_args: dict[str, Any] | None = None,
        source: str = "ginot",
    ) -> None:
        super().__init__()
        branch_args = branch_args or {
            "input_channels": 12,
            "out_c": 256,
            "width": 128,
            "latent_d": 1024,
            "n_point": 1024,
            "radius": 0.08,
        }
        trunk_args = trunk_args or {
            "in_channels": 3,
            "out_channels": 4,
            "embed_dim": 256,
            "cross_attn_layers": 5,
            "num_heads": 8,
            "min_length_norm": 0.1,
        }
        self.source = source
        self.normalization: PhysicsNormalization | None = None
        self.branch = PointCloudPerceiverChannelsEncoder(**branch_args)

        embed_dim = int(trunk_args.get("embed_dim", 256))
        in_channels = int(trunk_args.get("in_channels", 3))
        out_channels = int(trunk_args.get("out_channels", 4))
        cross_attn_layers = int(trunk_args.get("cross_attn_layers", 5))
        num_heads = int(trunk_args.get("num_heads", 8))
        self.fourier_enc = MildFourierEncoder(
            in_channels=in_channels,
            min_length=float(trunk_args.get("min_length_norm", 0.1)),
        )
        self.Q_encoder = nn.Sequential(
            nn.Linear(self.fourier_enc.out_channels, 2 * embed_dim),
            nn.SiLU(),
            nn.Linear(2 * embed_dim, embed_dim),
        )
        self.latent_encoder = nn.Sequential(
            nn.Linear(embed_dim, 2 * embed_dim),
            nn.SiLU(),
            nn.Linear(2 * embed_dim, embed_dim),
            nn.SiLU(),
        )
        self.resblocks = nn.ModuleList(
            [
                ResidualCrossAttentionBlock(width=embed_dim, heads=num_heads, dropout=0.0)
                for _ in range(cross_attn_layers)
            ]
        )
        self.output_proj = nn.Sequential(
            nn.Linear(embed_dim, 2 * embed_dim),
            nn.SiLU(),
            nn.Linear(2 * embed_dim, out_channels),
        )

    def _ensure_min_branch_points(self, pc: torch.Tensor) -> torch.Tensor:
        if pc.shape[1] >= self.branch.n_point:
            return pc
        repeats = math.ceil(self.branch.n_point / pc.shape[1])
        return pc.repeat(1, repeats, 1)[:, : self.branch.n_point]

    def encode_geometry(self, pc: torch.Tensor) -> torch.Tensor:
        return self.latent_encoder(self.branch(self._ensure_min_branch_points(pc)))

    def decode_query(self, latent: torch.Tensor, xyt: torch.Tensor) -> torch.Tensor:
        hidden = self.Q_encoder(self.fourier_enc(xyt))
        for block in self.resblocks:
            hidden = block(hidden, latent)
        return self.output_proj(hidden)

    def forward(self, load: torch.Tensor, xyt: torch.Tensor, pc: torch.Tensor) -> torch.Tensor:
        del load
        return self.decode_query(self.encode_geometry(pc), xyt)


class AnalyticFallbackGINOT(torch.nn.Module):
    """
    Deterministic fallback used when trained weights are unavailable.

    This is not a CFD-accurate replacement for Ginot. It preserves the
    request/response contract and produces smooth, geometry-aware fields so the
    backend remains usable until a real checkpoint is provided.
    """

    def forward(self, load, xyt, pc):
        xyt = xyt.to(dtype=torch.float32)
        pc = pc.to(dtype=torch.float32)
        load = load.to(dtype=torch.float32)

        inlet_center = load[:, None, 0:3]
        outlet_center = load[:, None, 3:6]
        inlet_velocity = load[:, None, 6:9]

        raw_direction = outlet_center - inlet_center
        fallback_direction = torch.nn.functional.normalize(raw_direction, dim=-1, eps=1e-6)
        inlet_speed = torch.linalg.vector_norm(inlet_velocity, dim=-1, keepdim=True)
        velocity_direction = torch.where(
            inlet_speed > 1e-6,
            inlet_velocity / inlet_speed.clamp_min(1e-6),
            fallback_direction,
        )

        pc_min = pc.amin(dim=1, keepdim=True)
        pc_max = pc.amax(dim=1, keepdim=True)
        room_center = (pc_min + pc_max) * 0.5
        room_extent = (pc_max - pc_min).clamp_min(1e-3)
        room_scale = room_extent.amax(dim=-1, keepdim=True).clamp_min(1e-3)

        inlet_offset = xyt - inlet_center
        outlet_offset = xyt - outlet_center
        dist_in = torch.linalg.vector_norm(inlet_offset, dim=-1, keepdim=True)
        dist_out = torch.linalg.vector_norm(outlet_offset, dim=-1, keepdim=True)

        source_sigma = (0.18 + room_scale * 0.15).clamp_min(0.1)
        sink_sigma = (0.24 + room_scale * 0.20).clamp_min(0.1)
        source_strength = torch.exp(-torch.square(dist_in / source_sigma))
        sink_strength = torch.exp(-torch.square(dist_out / sink_sigma))

        centerline = xyt - room_center
        swirl = torch.linalg.cross(
            velocity_direction.expand_as(centerline),
            centerline,
            dim=-1,
        )
        swirl = swirl / room_scale.clamp_min(1e-3)

        wall_clearance = torch.minimum(xyt - pc_min, pc_max - xyt)
        wall_damping = (wall_clearance / room_extent).clamp(0.0, 1.0).amin(dim=-1, keepdim=True)
        wall_damping = wall_damping.mul(2.0).clamp(0.05, 1.0)

        transport = inlet_velocity * source_strength
        recirculation = velocity_direction * (inlet_speed * sink_strength * 0.35)
        secondary = swirl * (inlet_speed * source_strength * 0.12)
        velocities = wall_damping * (transport + recirculation + secondary)

        pressure = 101325.0 + (sink_strength - source_strength).squeeze(-1) * 45.0
        pressure = pressure - dist_in.squeeze(-1) * 4.0 + wall_damping.squeeze(-1) * 6.0

        return torch.cat([velocities, pressure.unsqueeze(-1)], dim=-1)


class GINOTModel(torch.nn.Module):
    def __init__(self, *, source: str = "ginot") -> None:
        super().__init__()
        self.source = source
        self.branch = PointCloudPerceiverChannelsEncoder(
            input_channels=3,
            out_c=128,
            width=128,
            latent_d=None,
            n_point=512,
            n_sample=64,
            radius=0.1,
            d_hidden=[128, 128],
            fps_method="fps",
            num_heads=8,
            cross_attn_layers=1,
            self_attn_layers=2,
            pc_padding_val=-1000,
            dropout=0.0,
        )
        self.Q_encoder = nn.Sequential(
            PosEmbLinear("nerf", 3, 256),
            nn.GELU(),
            nn.Linear(256, 384),
            nn.GELU(),
            nn.Linear(384, 256),
            nn.GELU(),
            nn.Linear(256, 128),
        )
        self.loading_encoder = nn.Sequential(
            nn.Linear(9, 256),
            nn.GELU(),
            nn.Linear(256, 256),
            nn.GELU(),
            nn.Linear(256, 128),
        )
        self.latent_encoder = nn.Sequential(
            nn.Linear(256, 256),
            nn.GELU(),
            nn.Linear(256, 128),
        )
        self.resblocks = nn.ModuleList(
            [ResidualCrossAttentionBlock(width=128, heads=8, dropout=0.0) for _ in range(5)]
        )
        self.output_proj = nn.Sequential(
            nn.Linear(128, 256),
            nn.GELU(),
            nn.Dropout(0.0),
            nn.Linear(256, 384),
            nn.GELU(),
            nn.Dropout(0.0),
            nn.Linear(384, 384),
            nn.GELU(),
            nn.Dropout(0.0),
            nn.Linear(384, 256),
            nn.GELU(),
            nn.Dropout(0.0),
            nn.Linear(256, 4),
        )

    def _ensure_min_branch_points(self, pc: torch.Tensor) -> torch.Tensor:
        min_points = self.branch.n_point
        if pc.shape[1] >= min_points:
            return pc
        repeats = math.ceil(min_points / pc.shape[1])
        return pc.repeat(1, repeats, 1)[:, :min_points, :]

    @staticmethod
    def _extract_state_dict(payload: object) -> OrderedDict[str, torch.Tensor]:
        if isinstance(payload, OrderedDict) and payload and all(torch.is_tensor(v) for v in payload.values()):
            return payload

        if isinstance(payload, dict):
            nested = payload.get("state_dict") or payload.get("model_state_dict")
            if isinstance(nested, OrderedDict) and nested and all(torch.is_tensor(v) for v in nested.values()):
                return nested
            if payload and all(isinstance(k, str) and torch.is_tensor(v) for k, v in payload.items()):
                return OrderedDict(payload)

        raise ValueError("Unsupported checkpoint payload")

    @staticmethod
    def _normalize_state_dict(state_dict: OrderedDict[str, torch.Tensor]) -> OrderedDict[str, torch.Tensor]:
        keys = list(state_dict.keys())
        if keys and all(key.startswith("module.") for key in keys):
            return OrderedDict((key.removeprefix("module."), value) for key, value in state_dict.items())
        return state_dict

    @classmethod
    def load_from_checkpoint(cls, checkpoint_path: str | Path) -> "GINOTModel":
        checkpoint_path = Path(checkpoint_path)
        payload = torch.load(checkpoint_path, map_location="cpu", weights_only=False)

        if isinstance(payload, cls):
            payload.source = str(checkpoint_path)
            return payload

        if isinstance(payload, torch.nn.Module):
            setattr(payload, "source", str(checkpoint_path))
            return payload

        state_dict = cls._normalize_state_dict(cls._extract_state_dict(payload))
        model = cls(source=str(checkpoint_path))
        model.load_state_dict(state_dict)
        return model

    def forward(self, load, xyt, pc):
        pc = self._ensure_min_branch_points(pc)
        branch_tokens = self.branch(pc)
        query_tokens = self.Q_encoder(xyt)
        load_tokens = self.loading_encoder(load).unsqueeze(1).expand(-1, branch_tokens.shape[1], -1)
        latent_tokens = self.latent_encoder(torch.cat([branch_tokens, load_tokens], dim=-1))
        hidden = query_tokens
        for block in self.resblocks:
            hidden = block(hidden, latent_tokens)
        return self.output_proj(hidden)


def load_ginot_checkpoint(
    checkpoint_path: str | Path,
) -> tuple[nn.Module, PhysicsNormalization | None]:
    checkpoint_path = Path(checkpoint_path)
    payload = torch.load(checkpoint_path, map_location="cpu", weights_only=False)

    if isinstance(payload, nn.Module):
        setattr(payload, "source", str(checkpoint_path))
        return payload, getattr(payload, "normalization", None)

    state_dict = GINOTModel._normalize_state_dict(GINOTModel._extract_state_dict(payload))
    if "fourier_enc.freqs" not in state_dict:
        model = GINOTModel(source=str(checkpoint_path))
        model.load_state_dict(state_dict)
        return model, None

    metadata = payload.get("normalization") if isinstance(payload, dict) else None
    config = payload.get("model_config", {}) if isinstance(payload, dict) else {}
    if metadata is None:
        sidecar_path = checkpoint_path.with_suffix(".json")
        if sidecar_path.exists():
            sidecar = json.loads(sidecar_path.read_text())
            metadata = sidecar.get("normalization")
            config = sidecar.get("model_config", config)
    if metadata is None:
        raise ValueError(
            "Physics GINOT checkpoint requires normalization metadata in the checkpoint "
            f"or {checkpoint_path.with_suffix('.json').name}"
        )

    model = PhysicsGINOTModel(
        branch_args=config.get("branch_args"),
        trunk_args=config.get("trunk_args"),
        source=str(checkpoint_path),
    )
    model.load_state_dict(state_dict)
    normalization = PhysicsNormalization.from_dict(metadata)
    model.normalization = normalization
    return model, normalization
