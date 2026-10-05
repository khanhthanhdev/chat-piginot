# syntax=docker/dockerfile:1.7

# ---- builder: install deps with uv ----
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim AS builder

ENV UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/opt/venv

WORKDIR /build

COPY uv.lock pyproject.toml ./

RUN uv sync --frozen --no-install-project --no-dev --no-editable

# ---- runtime: minimal production image ----
FROM python:3.12-slim-bookworm AS runtime

LABEL image.description="LGO indoor-airflow inference backend"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONFAULTHANDLER=1 \
    PYTHONHASHSEED=random \
    LANG=C.UTF-8 \
    PATH="/opt/venv/bin:$PATH" \
    PYTHONPATH="/app/lgo:/app" \
    LGO_MODELS_DIR="/models" \
    LGO_CASES_DIRS="/cases/gap30:/cases/gap58"

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/* \
    && addgroup --system app \
    && adduser --system --ingroup app --home /app app \
    && mkdir -p /app/results /models /cases/gap30 /cases/gap58 \
    && chown -R app:app /app

# Deps from builder
COPY --from=builder /opt/venv /opt/venv

COPY --chown=app:app app/ ./app/
COPY --chown=app:app lgo/ ./lgo/
COPY --chown=app:app results/summary.csv ./results/summary.csv

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["/opt/venv/bin/python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')"]

USER app

EXPOSE 8000

ENTRYPOINT ["/opt/venv/bin/python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
