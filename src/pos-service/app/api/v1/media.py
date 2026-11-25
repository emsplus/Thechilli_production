"""Public, immutable menu photos. <img> tags cannot send the Bearer header and the PWA caches photos offline, so there is
NO auth: the URL itself is the capability (content hash + 64 random bits, see services/menu_images.py). Only strictly
named .webp files inside <storage_dir>/<restaurant_id>/menu/ are served; anything else is a plain 404."""
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from app.services.menu_images import resolve

router = APIRouter(tags=["media"])


@router.get("/media/menu/{restaurant_id}/{filename}", response_class=FileResponse)
def menu_image(restaurant_id: str, filename: str):
    path = resolve(restaurant_id, filename)
    if path is None:
        raise HTTPException(404, "Not found")
    # HardeningMiddleware keeps this Cache-Control for 200/206/304 under /api/v1/media/ only (no-store elsewhere);
    # nosniff comes from the middleware as on every response.
    return FileResponse(path, media_type="image/webp", headers={"Cache-Control": "public, max-age=31536000, immutable"})
