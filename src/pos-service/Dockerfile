# syntax=docker/dockerfile:1.7
# Restaurant POS API image. Build context: apps/api
#   docker build -t pos-api:local apps/api
# Base images are pinned by version AND digest; bump both together (see docs/runbook.md "Upgrading base images").
ARG PYTHON_IMAGE=python:3.12.15-slim-trixie@sha256:a0f57064cbdcd6285fa45f51237ab0b35ea8ebaed06a1f5973e89e19dfb86704
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.11.33@sha256:77280f2f771df71f90786c314fe1bbc1e023feac652969bbf139c280babf2eb7

FROM ${UV_IMAGE} AS uv

# ---- tax-engine-in (India GST engine, zero dependencies, lives in a sibling repo) --------------------------------
# Supplied as a named build context: `docker build --build-context taxengine=../tax-engine-in ...` (compose:
# build.additional_contexts.taxengine). Without it this stage is empty and the image builds, but gst_engine restaurants
# answer 503 "tax-engine-in is not installed" (app/services/gst.py).
FROM ${PYTHON_IMAGE} AS taxengine
RUN mkdir -p /src/tax_engine_in

# ---- builder: resolve the locked dependency set into /app/.venv ------------------------------------------------
FROM ${PYTHON_IMAGE} AS builder
COPY --from=uv /uv /uvx /bin/
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PYTHON=/usr/local/bin/python3 \
    UV_PROJECT_ENVIRONMENT=/app/.venv
WORKDIR /app
# Dependencies only (cached layer): exactly what uv.lock says, no dev group. Fails if the lock is out of date.
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    uv sync --frozen --no-dev --no-install-project

# ---- runtime ----------------------------------------------------------------------------------------------------
FROM ${PYTHON_IMAGE} AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH=/app/.venv/bin:$PATH \
    PYTHONPATH=/app:/app/docker:/app/vendor \
    STORAGE_DIR=/app/storage \
    PORT=8000
RUN groupadd --system --gid 10001 app \
 && useradd --system --uid 10001 --gid app --home-dir /app --no-create-home --shell /usr/sbin/nologin app
RUN apt-get update && apt-get install -y --no-install-recommends libraqm0 libfribidi0 \
 && rm -rf /var/lib/apt/lists/*  # Devanagari shaping for thermal receipts (docs/INDIA.md)
WORKDIR /app
COPY --from=builder /app/.venv /app/.venv
# Code is owned by root and read-only for the app user; only /app/storage is writable (mount a volume there).
COPY alembic.ini pyproject.toml ./
COPY alembic ./alembic
COPY app ./app
COPY docker ./docker
COPY scripts ./scripts
COPY --from=taxengine /src/tax_engine_in ./vendor/tax_engine_in
RUN chmod 0755 /app/docker/entrypoint.sh \
 && python -m compileall -q app alembic docker vendor \
 && mkdir -p /app/storage && chown app:app /app/storage
ARG POS_VERSION=dev
LABEL org.opencontainers.image.title="pos-api" org.opencontainers.image.version="${POS_VERSION}"
ENV POS_VERSION=${POS_VERSION}
USER app
EXPOSE 8000
VOLUME ["/app/storage"]
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD ["python", "-c", "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/api/v1/health' % os.environ.get('PORT','8000'), timeout=4)"]
ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["serve"]
