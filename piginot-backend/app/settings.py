from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import torch


def _split_csv(value: str | None, default: tuple[str, ...]) -> tuple[str, ...]:
    if value is None:
        return default
    items = tuple(part.strip() for part in value.split(",") if part.strip())
    return items or default


def resolve_device(device_preference: str) -> str:
    normalized = device_preference.strip().lower()
    if normalized == "auto":
        return "cuda" if torch.cuda.is_available() else "cpu"
    if normalized == "cuda" and not torch.cuda.is_available():
        return "cpu"
    return normalized


@dataclass(frozen=True)
class Settings:
    model_path: Path
    onnx_model_path: Path
    inference_engine: str
    device_preference: str
    max_boundary_points: int
    max_interior_points: int
    inference_timeout_seconds: float
    cors_allow_origins: tuple[str, ...]
    rate_limit_times: int
    rate_limit_window_seconds: int
    allow_fallback_model: bool

    @property
    def device(self) -> str:
        return resolve_device(self.device_preference)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    repo_root = Path(__file__).resolve().parents[1]
    default_origins = ("*",)
    return Settings(
        model_path=repo_root / os.getenv("GINOT_MODEL_PATH", "saved_weights/ginot_trained_multicase.pth"),
        onnx_model_path=repo_root / os.getenv("GINOT_ONNX_MODEL_PATH", "saved_weights/ginot.onnx"),
        inference_engine=os.getenv("GINOT_INFERENCE_ENGINE", "torch").strip().lower(),
        device_preference=os.getenv("DEVICE", "auto"),
        max_boundary_points=int(os.getenv("MAX_BOUNDARY_POINTS", "100000")),
        max_interior_points=int(os.getenv("MAX_INTERIOR_POINTS", "50000")),
        inference_timeout_seconds=float(os.getenv("INFERENCE_TIMEOUT_SECONDS", "30")),
        cors_allow_origins=_split_csv(os.getenv("CORS_ALLOW_ORIGINS"), default_origins),
        rate_limit_times=int(os.getenv("RATE_LIMIT_TIMES", "10")),
        rate_limit_window_seconds=int(os.getenv("RATE_LIMIT_WINDOW_SECONDS", "60")),
        allow_fallback_model=os.getenv("PIGINOT_ALLOW_SYNTHETIC", "").strip().lower()
        in {"1", "true", "yes"},
    )
