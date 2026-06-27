from __future__ import annotations

import time


class InferenceTimeoutError(RuntimeError):
    """Raised when an inference flow exceeds the configured timeout."""


def compute_elapsed_time_ms(started_at: float) -> float:
    return round((time.perf_counter() - started_at) * 1000, 2)


def ensure_within_timeout(compute_time_ms: float, timeout_seconds: float) -> None:
    if compute_time_ms > timeout_seconds * 1000:
        raise InferenceTimeoutError("Inference exceeded configured timeout")
