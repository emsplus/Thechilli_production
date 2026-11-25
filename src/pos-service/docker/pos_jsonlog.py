"""Minimal JSON log formatter (stdlib only) used by docker/log-config.json: one JSON object per line on stdout."""
import json
import logging
import re
from datetime import datetime, timezone

# Capability URLs must not end up in logs in full (security review finding 9): anyone with log access could open the
# receipt (customer name / phone). Keep 6 characters so a support person can still correlate a request.
_SECRET_PATHS = re.compile(r"(/public/receipts/)([A-Za-z0-9_-]{6})[A-Za-z0-9_-]*")


def mask_path(path: str) -> str:
    return _SECRET_PATHS.sub(r"\1\2...", path) if isinstance(path, str) else path


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        out = {
            "ts": datetime.fromtimestamp(record.created, timezone.utc).isoformat(timespec="milliseconds"),
            "level": record.levelname.lower(),
            "logger": record.name,
        }
        args = record.args
        if record.name == "uvicorn.access" and isinstance(args, tuple) and len(args) == 5:
            client, method, path, http_version, status = args
            out.update(msg="request", client=client, method=method, path=mask_path(path),
                       http_version=http_version, status=int(status))
        else:
            out["msg"] = mask_path(record.getMessage())
        if record.exc_info:
            out["exc"] = self.formatException(record.exc_info)
        return json.dumps(out, default=str, ensure_ascii=False)
