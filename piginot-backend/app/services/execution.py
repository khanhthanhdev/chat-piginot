from __future__ import annotations

from collections.abc import Callable
from threading import BoundedSemaphore
from typing import TypeVar

from anyio import to_thread

from ..settings import get_settings

T = TypeVar("T")
_cuda_slot = BoundedSemaphore(1)


async def run_inference_in_worker(fn: Callable[[], T]) -> T:
    def execute() -> T:
        if get_settings().device != "cuda":
            return fn()
        with _cuda_slot:
            return fn()

    return await to_thread.run_sync(execute)
