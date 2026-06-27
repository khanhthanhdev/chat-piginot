from __future__ import annotations

from pydantic import ValidationError
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse


def format_validation_error(
    exc: ValidationError | RequestValidationError,
    *,
    exclude_body_location: bool = False,
    fallback_message: str = "Invalid request body",
) -> str:
    messages: list[str] = []
    for error in exc.errors():
        location_parts = [
            str(part)
            for part in error.get("loc", [])
            if not (exclude_body_location and part == "body")
        ]
        location = ".".join(location_parts)
        message = error.get("msg", fallback_message)
        messages.append(f"{location}: {message}" if location else message)

    return "; ".join(messages) if messages else fallback_message


async def request_validation_exception_handler(
    _,
    exc: ValidationError | RequestValidationError,
):
    detail = format_validation_error(
        exc,
        exclude_body_location=True,
        fallback_message="Invalid request body",
    )
    return JSONResponse(status_code=400, content={"detail": detail})
