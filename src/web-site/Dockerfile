# syntax=docker/dockerfile:1.7
# Static marketing website (Vite + React SPA) served at https://${DOMAIN_SITE}/ by an unprivileged nginx.
# Bundle-owned file: deploy/make-bundle.sh copies it (with nginx.conf, security-headers.conf, .dockerignore) next to the web-site source.
# The router sends /signup*, /terms*, /privacy*, /_next/*, /brand/* to web-public and everything else here (Caddyfile).
#   docker build -t chilli-web-site src/web-site
ARG NODE_IMAGE=node:24-alpine
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.31.7-alpine

FROM ${NODE_IMAGE} AS build
SHELL ["/bin/ash", "-eo", "pipefail", "-c"]
WORKDIR /w
ENV CI=1 NODE_ENV=development npm_config_fund=false npm_config_audit=false npm_config_update_notifier=false
COPY package.json package-lock.json ./
RUN --mount=type=cache,id=npm-cache,target=/root/.npm npm ci --no-audit --no-fund
COPY index.html vite.config.js ./
COPY public ./public
COPY src ./src
RUN npx vite build && test -f dist/index.html

FROM ${NGINX_IMAGE} AS runtime
# The image runs as uid 101 (nginx) on port 8080, pid and temp files in /tmp (tmpfs in compose; root filesystem read-only).
COPY --chown=root:root nginx.conf /etc/nginx/conf.d/default.conf
COPY --chown=root:root security-headers.conf /etc/nginx/security-headers.conf
COPY --from=build --chown=root:root /w/dist /usr/share/nginx/html
USER 101
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/healthz"]
