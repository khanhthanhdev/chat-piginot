from __future__ import annotations

import math
from collections import OrderedDict
from pathlib import Path

import torch
import torch.nn as nn

from .point_encoding import PointCloudPerceiverChannelsEncoder
from .point_position_embedding import PosEmbLinear
from .transformer import ResidualCrossAttentionBlock


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
