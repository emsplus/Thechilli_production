# syntax=docker/dockerfile:1.7
# platform-core image.   docker build -t platform-core:local .
# Run migrations with:   docker run --rm --env-file .env platform-core:local migrate
FROM python:3.12-slim AS builder
COPY --from=ghcr.io/astral-sh/uv:0.5 /uv /bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PROJECT_ENVIRONMENT=/app/.venv
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PATH=/app/.venv/bin:$PATH PORT=8000
RUN groupadd --system --gid 10001 app && useradd --system --uid 10001 --gid app --no-create-home --shell /usr/sbin/nologin app
WORKDIR /app
COPY --from=builder /app/.venv /app/.venv
COPY alembic.ini pyproject.toml ./
COPY alembic ./alembic
COPY app ./app
COPY docker ./docker
COPY scripts ./scripts
RUN chmod 0755 docker/entrypoint.sh
# ENV is not set here: it defaults to production (fail closed), which requires JWT_KEYRING / JWT_KEYRING_FILE.
USER app
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD ["python", "-c", "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/api/v1/health' % os.environ.get('PORT','8000'), timeout=4)"]
ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["serve"]
