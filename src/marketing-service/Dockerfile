# syntax=docker/dockerfile:1.7
# Marketing & onboarding API (Portal C).   docker build -t marketing-service:local .
# Pin PYTHON_IMAGE / UV_IMAGE by digest for production builds (see pos-service Dockerfile for the convention).
ARG PYTHON_IMAGE=python:3.12-slim-trixie
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.11

FROM ${UV_IMAGE} AS uv

FROM ${PYTHON_IMAGE} AS builder
COPY --from=uv /uv /uvx /bin/
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never UV_PYTHON=/usr/local/bin/python3 \
    UV_PROJECT_ENVIRONMENT=/app/.venv
WORKDIR /app
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    uv sync --frozen --no-dev --no-install-project

FROM ${PYTHON_IMAGE} AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PATH=/app/.venv/bin:$PATH PYTHONPATH=/app PORT=8200
RUN groupadd --system --gid 10001 app \
 && useradd --system --uid 10001 --gid app --home-dir /app --no-create-home --shell /usr/sbin/nologin app
WORKDIR /app
COPY --from=builder /app/.venv /app/.venv
COPY alembic.ini pyproject.toml ./
COPY alembic ./alembic
COPY app ./app
COPY docker ./docker
COPY scripts ./scripts
RUN chmod 0755 /app/docker/entrypoint.sh && python -m compileall -q app alembic \
 && mkdir -p /app/var/documents && chown -R app:app /app/var
USER app
EXPOSE 8200
# ENV defaults to production: JWT_SECRET (>= 32 chars) and DATABASE_URL must be provided at run time.
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD ["python", "-c", "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/api/v1/health' % os.environ.get('PORT','8200'), timeout=4)"]
ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["serve"]
