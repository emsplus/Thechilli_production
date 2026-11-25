"""Writes the OpenAPI document (docs are off in production, so it is generated from the app object) for consumers that pin
a contract, e.g. web-super-admin/contracts/platform-core.openapi.json.

    ENV=development PYTHONPATH=. uv run python scripts/export_openapi.py ../web-super-admin/contracts/platform-core.openapi.json
"""
import json
import os
import sys

os.environ.setdefault("ENV", "development")
from app.main import app  # noqa: E402

doc = app.openapi()
text = json.dumps(doc, indent=2, sort_keys=True) + "\n"
if len(sys.argv) > 1:
    os.makedirs(os.path.dirname(os.path.abspath(sys.argv[1])), exist_ok=True)
    open(sys.argv[1], "w").write(text)
else:
    sys.stdout.write(text)
