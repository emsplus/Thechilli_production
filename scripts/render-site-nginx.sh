#!/usr/bin/env bash
# Turn the nginx file deploy.sh rendered for ONE stack (config/nginx/thechilli.conf) into the file to install on the shared host when the
# website is its own stack (deploy/site). Prints the result on stdout; installs nothing.
#
#   scripts/render-site-nginx.sh prod [stack-conf]   Prod:  the site hostname's /signup, /_next, /brand and the Razorpay webhook go to the
#                                                     Prod router, every other path to the standalone website (127.0.0.1:SITE_PORT)
#   scripts/render-site-nginx.sh uat  [stack-conf]   UAT:   the site hostname keeps ONLY sign-up and the webhook (UAT has no website copy);
#                                                     every other path redirects to the one real website
#
# Both stacks' files can then live side by side in /etc/nginx/conf.d: every nginx name that would otherwise collide (upstream, websocket
# map, TLS session cache zones) is suffixed with the environment (_prod / _uat).
# Env: SITE_PORT (7095), MAIN_SITE (https://thechilli.zonov.ai, where UAT sends visitors of its site hostname).
set -euo pipefail
cd "$(dirname "$0")/.."
env_name=${1:-}; conf=${2:-config/nginx/thechilli.conf}
case "$env_name" in prod|uat) ;; *) echo "usage: scripts/render-site-nginx.sh prod|uat [stack nginx conf]" >&2; exit 2;; esac
[ -f "$conf" ] || { echo "no such file: $conf (run scripts/deploy.sh first: it renders it)" >&2; exit 2; }
SITE_PORT=${SITE_PORT:-7095} MAIN_SITE=${MAIN_SITE:-https://thechilli.zonov.ai} ENV_NAME=$env_name CONF=$conf python3 - <<'PY'
import os, re, sys
env, conf = os.environ["ENV_NAME"], os.environ["CONF"]
site_port, main_site = os.environ["SITE_PORT"], os.environ["MAIN_SITE"].rstrip("/")
t = open(conf).read()

# 1. unique names per environment (two stacks' files must be includable together)
for old in ("chilli_router", "chilli_connection_upgrade", "chilli_ssl_top", "chilli_ssl_sub"):
    t = re.sub(r"(?<![A-Za-z0-9_])" + old + r"(?![A-Za-z0-9_])", f"{old}_{env}", t)

# 2. the site hostname is no longer served by the stack's catch-all block: drop it from the TLS "top" block's server_name
lines = t.split("\n")
site = None
for i, l in enumerate(lines):
    m = re.match(r"^(\s*)server_name\s+([^;]+);\s*$", l)
    if not m or not any(re.match(r"\s*ssl_certificate\s", x) for x in lines[i + 1:i + 3]):
        continue
    names = m.group(2).split()
    if len(names) == 3:               # the "top" block: SITE ADMIN PARTNER (the other TLS block has four names)
        site = names[0]
        lines[i] = f"{m.group(1)}server_name {' '.join(names[1:])};"
        cert = next(x for x in lines[i + 1:i + 3] if "ssl_certificate " in x).split()[1].rstrip(";")
        key = next(x for x in lines[i + 1:i + 4] if "ssl_certificate_key" in x).split()[1].rstrip(";")
        break
if site is None:
    sys.exit("could not find the SITE/ADMIN/PARTNER server block in " + conf + " (is it the file deploy.sh rendered?)")
t = "\n".join(lines)
router = f"chilli_router_{env}"; upg = f"chilli_connection_upgrade_{env}"

proxy = lambda up: f"""        proxy_pass http://{up};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection ${upg};
        proxy_connect_timeout 10s;
        proxy_send_timeout 120s;
        proxy_read_timeout 120s;"""
to_stack = f"""    # sign-up, its assets and the Razorpay webhook belong to the {env.upper()} stack (same routes its router has for this hostname)
    location ~ ^/(signup($|/)|_next/|brand/) {{
{proxy(router)}
    }}
    location ~ ^/api/webhooks/razorpay/?$ {{
{proxy(router)}
    }}"""
if env == "prod":
    site_block = f"""
upstream thechilli_site {{
    server 127.0.0.1:{site_port};
    keepalive 8;
}}
# The public website: its own stack (deploy/site), shared by Prod and UAT (whose buttons point here).
server {{
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name {site};
    ssl_certificate     {cert};
    ssl_certificate_key {key};
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:chilli_ssl_site:5m;
    server_tokens off;
    add_header Strict-Transport-Security "max-age=31536000" always;
    client_max_body_size 25m;
{to_stack}
    location / {{
        proxy_pass http://thechilli_site;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_connect_timeout 10s;
        proxy_read_timeout 60s;
    }}
}}
"""
else:
    site_block = f"""
# UAT has no website of its own: this hostname is only for sign-up (and the test Razorpay webhook); everything else goes to the real website.
server {{
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name {site};
    ssl_certificate     {cert};
    ssl_certificate_key {key};
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:chilli_ssl_uatsite:5m;
    server_tokens off;
    add_header Strict-Transport-Security "max-age=31536000" always;
    client_max_body_size 25m;
{to_stack}
    location / {{
        return 302 {main_site}/;
    }}
}}
"""
sys.stdout.write(t.rstrip("\n") + "\n" + site_block)
PY
