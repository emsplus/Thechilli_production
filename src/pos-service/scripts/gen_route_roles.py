"""Writes tests/fixtures/route_roles.json: for every route, the roles allowed by its role guard (null = no role guard, any
authenticated user or a public route). The contract the permission model must reproduce (docs/PERMISSIONS.md).
Run: uv run python scripts/gen_route_roles.py"""
import json
import sys

from app.main import app


def guard_roles(dependant):
    out = []
    for d in dependant.dependencies:
        call = d.call
        roles = getattr(call, "roles", None)
        if roles is None and getattr(call, "__closure__", None) and getattr(call, "__name__", "") == "checker":
            cell = call.__closure__[0].cell_contents
            if isinstance(cell, tuple):
                roles = cell
        if roles is not None:
            out.append(sorted(r.value for r in roles))
        out.extend(guard_roles(d))
    return out


def iter_routes():
    """Every effective route (path incl. prefix, methods, dependant), flattening FastAPI's nested included routers."""
    for r in app.routes:
        if hasattr(r, "effective_route_contexts"):
            yield from r.effective_route_contexts()
        elif hasattr(r, "dependant"):
            yield r


def build() -> dict:
    res = {}
    for r in iter_routes():
        g = guard_roles(r.dependant)
        for m in sorted(r.methods - {"HEAD", "OPTIONS"}):
            res[f"{m} {r.path}"] = g[0] if g else None
    return dict(sorted(res.items()))


if __name__ == "__main__":
    with open(sys.argv[1] if len(sys.argv) > 1 else "tests/fixtures/route_roles.json", "w") as f:
        json.dump(build(), f, indent=1)
