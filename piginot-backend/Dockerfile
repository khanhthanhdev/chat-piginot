# syntax=docker/dockerfile:1.7

# ---- builder: install deps with uv ----
FROM ghcr.io/astral-sh/uv:python3.14-bookworm-slim AS builder

ENV UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/opt/venv

WORKDIR /build

COPY uv.lock pyproject.toml ./

RUN uv sync --frozen --no-install-project --no-dev --no-editable

# ---- runtime: minimal production image ----
FROM python:3.14-slim-bookworm AS runtime

LABEL maintainer="VinUni CFD Team" \
      image.description="FastAPI CFD inference backend with PyTorch"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONFAULTHANDLER=1 \
    PYTHONHASHSEED=random \
    LANG=C.UTF-8 \
    PATH="/opt/venv/bin:$PATH"

WORKDIR /app

RUN addgroup --system app \
    && adduser --system --ingroup app --home /app app \
    && mkdir -p /app/data/visualizations \
    && chown -R app:app /app

# Deps from builder
COPY --from=builder /opt/venv /opt/venv

# Copy only runtime Python sources so training code and caches never enter the image.
COPY --chown=app:app app/*.py ./app/
COPY --chown=app:app app/http/*.py ./app/http/
COPY --chown=app:app app/models/*.py ./app/models/
COPY --chown=app:app app/services/*.py ./app/services/

# Model weights — only the file actually needed
COPY --chown=app:app saved_weights/ginot_trained_multicase.pth ./saved_weights/ginot_trained_multicase.pth

USER app

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["/opt/venv/bin/python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')"]

ENTRYPOINT ["/opt/venv/bin/python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
