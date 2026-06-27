from __future__ import annotations

import logging
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

import numpy as np
import torch

from .models.ginot import AnalyticFallbackGINOT, GINOTModel
from .settings import resolve_device


LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True)
class InferenceRuntime:
    model: Any
    engine: str
    device: str
    source: str
    checkpoint_path: str | None


@dataclass(frozen=True)
class InferencePrediction:
    positions: np.ndarray
    velocities: np.ndarray
    pressure: np.ndarray
    speed: np.ndarray


@lru_cache(maxsize=8)
def get_inference_runtime(
    model_path: str,
    device_preference: str,
    allow_fallback_model: bool = True,
    engine: str = "torch",
    onnx_model_path: str | None = None,
) -> InferenceRuntime:
    resolved_device = resolve_device(device_preference)
    normalized_engine = engine.strip().lower()
    if normalized_engine == "onnx":
        return _load_onnx_runtime(
            onnx_model_path or model_path,
            resolved_device,
        )
    if normalized_engine != "torch":
        raise ValueError(f"Unsupported inference engine: {engine}")

    checkpoint_path = Path(model_path)

    if checkpoint_path.exists():
        try:
            model = GINOTModel.load_from_checkpoint(checkpoint_path)
            model.eval()
            model.to(resolved_device)
            return InferenceRuntime(
                model=model,
                engine="torch",
                device=resolved_device,
                source=model.source,
                checkpoint_path=str(checkpoint_path),
            )
        except Exception:
            LOGGER.exception("Failed to load Ginot checkpoint from %s", checkpoint_path)
            if not allow_fallback_model:
                raise
    elif not allow_fallback_model:
        raise FileNotFoundError(f"Ginot checkpoint not found: {checkpoint_path}")

    fallback_model = AnalyticFallbackGINOT()
    fallback_model.eval()
    fallback_model.to(resolved_device)
    return InferenceRuntime(
        model=fallback_model,
        engine="torch",
        device=resolved_device,
        source="analytic-fallback",
        checkpoint_path=str(checkpoint_path),
    )


def _load_onnx_runtime(model_path: str, device: str) -> InferenceRuntime:
    checkpoint_path = Path(model_path)
    if not checkpoint_path.exists():
        raise FileNotFoundError(f"ONNX model not found: {checkpoint_path}")

    try:
        import onnxruntime as ort
    except ImportError as exc:
        raise RuntimeError("ONNX Runtime is not installed. Install the onnxruntime package.") from exc

    available = set(ort.get_available_providers())
    providers = ["CPUExecutionProvider"]
    if device == "cuda" and "CUDAExecutionProvider" in available:
        providers.insert(0, "CUDAExecutionProvider")

    session = ort.InferenceSession(str(checkpoint_path), providers=providers)
    return InferenceRuntime(
        model=session,
        engine="onnx",
        device=device,
        source=f"onnx:{checkpoint_path}",
        checkpoint_path=str(checkpoint_path),
    )


@torch.inference_mode()
def run_inference(
    load: torch.Tensor,
    pc: torch.Tensor,
    xyt: torch.Tensor,
    model: Any,
    device: str = "cuda",
    engine: str = "torch",
) -> InferencePrediction:
    if engine == "onnx":
        prediction = _run_onnx_inference(load, pc, xyt, model)
    else:
        load_device = load.to(device)
        pc_device = pc.to(device)
        xyt_device = xyt.to(device)
        prediction = model(load_device, xyt_device, pc_device)

    if prediction.ndim != 3:
        raise RuntimeError(f"Ginot model must return a rank-3 tensor, got shape {tuple(prediction.shape)}")
    if prediction.shape[0] != load.shape[0] or prediction.shape[1] != xyt.shape[1] or prediction.shape[2] != 4:
        raise RuntimeError(
            "Ginot model returned unexpected output shape: "
            f"expected ({load.shape[0]}, {xyt.shape[1]}, 4), got {tuple(prediction.shape)}"
        )

    pred_np = prediction.squeeze(0).detach().cpu().numpy().astype(np.float32, copy=False)
    positions = xyt.squeeze(0).detach().cpu().numpy().astype(np.float32, copy=False)
    velocities = pred_np[:, :3]
    pressure = pred_np[:, 3]
    speed = np.linalg.norm(velocities, axis=1)

    return InferencePrediction(
        positions=positions,
        velocities=velocities,
        pressure=pressure,
        speed=speed.astype(np.float32, copy=False),
    )


def _run_onnx_inference(
    load: torch.Tensor,
    pc: torch.Tensor,
    xyt: torch.Tensor,
    session: Any,
) -> torch.Tensor:
    inputs = session.get_inputs()
    values = {
        "load": load.detach().cpu().numpy().astype(np.float32, copy=False),
        "xyt": xyt.detach().cpu().numpy().astype(np.float32, copy=False),
        "pc": pc.detach().cpu().numpy().astype(np.float32, copy=False),
    }
    feed = {}
    for input_meta, fallback_name in zip(inputs, values):
        feed[input_meta.name] = values[input_meta.name] if input_meta.name in values else values[fallback_name]
    output = session.run(None, feed)[0]
    return torch.from_numpy(np.asarray(output, dtype=np.float32))
