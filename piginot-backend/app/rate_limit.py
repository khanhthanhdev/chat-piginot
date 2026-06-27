from __future__ import annotations

from collections import defaultdict, deque
from threading import Lock
from time import monotonic

from fastapi import HTTPException, status
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response


class MemoryRateLimitMiddleware(BaseHTTPMiddleware):
    def __init__(
        self,
        app,
        *,
        limit: int,
        window_seconds: int,
        path_prefix: str = "/api/",
    ) -> None:
        super().__init__(app)
        self.limit = limit
        self.window_seconds = window_seconds
        self.path_prefix = path_prefix
        self._lock = Lock()
        self._requests: dict[str, deque[float]] = defaultdict(deque)

    def _client_key(self, request: Request) -> str:
        client_host = request.headers.get("x-forwarded-for", "unknown").split(",")[0].strip()
        return f"{client_host}:{request.url.path}"

    async def dispatch(self, request: Request, call_next) -> Response:
        if self.limit <= 0 or not request.url.path.startswith(self.path_prefix):
            return await call_next(request)

        now = monotonic()
        key = self._client_key(request)

        with self._lock:
            bucket = self._requests[key]
            cutoff = now - self.window_seconds
            while bucket and bucket[0] <= cutoff:
                bucket.popleft()

            if len(bucket) >= self.limit:
                raise HTTPException(
                    status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                    detail="Rate limit exceeded",
                )

            bucket.append(now)

        return await call_next(request)
