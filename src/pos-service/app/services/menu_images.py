"""Menu item photos: sniff, re-encode to metadata-free WebP, store under <storage_dir>/<restaurant_id>/menu/.

File names are server-generated: <sha256(main webp)[:16]>-<16 random hex>[-thumb].webp. The hash makes a new photo a new
URL (immutable caching), the random part makes URLs unguessable even for a known image. Served by app/api/v1/media.py."""
import hashlib
import io
import re
import secrets
from pathlib import Path

from fastapi import HTTPException
from PIL import Image, ImageOps, UnidentifiedImageError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.core import MenuItem
from app.services import audit

MAIN_PX, THUMB_PX = 800, 320
MAX_PIXELS = 40_000_000  # decoded size cap (decompression bombs); a 40 MP phone photo is fine
WEBP_QUALITY = 82
FILENAME_RE = re.compile(r"^[0-9a-f]{16}-[0-9a-f]{16}(-thumb)?\.webp$")
RESTAURANT_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def sniff(data: bytes) -> str | None:
    """Pillow format name from magic bytes; the client's content-type and file name are never trusted."""
    if data.startswith(b"\xff\xd8\xff"):
        return "JPEG"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "PNG"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "WEBP"
    return None


def media_dir(restaurant_id) -> Path:
    return Path(settings.storage_dir) / str(restaurant_id) / "menu"


def resolve(restaurant_id: str, filename: str) -> Path | None:
    """Path of a stored photo, or None. Strict names + a resolved-path containment check: no traversal."""
    if not RESTAURANT_RE.fullmatch(restaurant_id) or not FILENAME_RE.fullmatch(filename):
        return None
    base = media_dir(restaurant_id).resolve()
    path = (base / filename).resolve()
    if path.parent != base or not path.is_file():
        return None
    return path


def _encode(im: Image.Image, px: int) -> bytes:
    im = im.copy()
    im.thumbnail((px, px), Image.LANCZOS)  # keeps aspect ratio, never upscales
    # Fresh image from raw pixels: no EXIF/XMP/ICC/comments can survive into the output.
    clean = Image.frombytes(im.mode, im.size, im.tobytes())
    out = io.BytesIO()
    clean.save(out, "WEBP", quality=WEBP_QUALITY, method=4)
    return out.getvalue()


def process(data: bytes) -> tuple[bytes, bytes]:
    """-> (main webp, thumbnail webp). 415 for non-images, 422 for corrupt or absurdly large ones."""
    fmt = sniff(data)
    if fmt is None:
        raise HTTPException(415, "Upload a JPEG, PNG or WebP image")
    try:
        with Image.open(io.BytesIO(data), formats=[fmt]) as im:
            if im.width * im.height > MAX_PIXELS:
                raise HTTPException(422, "Image dimensions are too large")
            im.seek(0)  # animated PNG/WebP: first frame only
            im.load()
            im = ImageOps.exif_transpose(im)  # apply the camera orientation before the EXIF is dropped
            has_alpha = im.mode in ("RGBA", "LA", "PA") or (im.mode == "P" and "transparency" in im.info)
            im = im.convert("RGBA" if has_alpha else "RGB")
    except HTTPException:
        raise
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError, Image.DecompressionBombError):
        raise HTTPException(422, "The image file is damaged or unsupported")
    return _encode(im, MAIN_PX), _encode(im, THUMB_PX)


def _delete(restaurant_id, *names: str | None) -> None:
    for n in names:
        if n:
            (media_dir(restaurant_id) / n).unlink(missing_ok=True)


def set_image(db: Session, p, item: MenuItem, data: bytes) -> MenuItem:
    """Caller has loaded `item` FOR UPDATE and checked the tenant. Old files are deleted only after the commit."""
    if not data or len(data) > settings.max_image_bytes:
        raise HTTPException(413, f"Image is empty or larger than {settings.max_image_bytes // (1024 * 1024)} MB")
    main, thumb = process(data)
    stem = f"{hashlib.sha256(main).hexdigest()[:16]}-{secrets.token_hex(8)}"
    names = (f"{stem}.webp", f"{stem}-thumb.webp")
    d = media_dir(item.restaurant_id)
    d.mkdir(parents=True, exist_ok=True)
    (d / names[0]).write_bytes(main)
    (d / names[1]).write_bytes(thumb)
    old = (item.image_key, item.thumb_key)
    item.image_key, item.thumb_key = names
    audit.record(db, p, "item.image_set", "menu_item", item.id,
                 {"image": names[0], "bytes_in": len(data), "bytes_out": len(main) + len(thumb), "replaced": old[0]})
    try:
        db.commit()
    except Exception:
        db.rollback()
        _delete(item.restaurant_id, *names)
        raise
    _delete(item.restaurant_id, *old)
    db.refresh(item)
    return item


def clear_image(db: Session, p, item: MenuItem) -> None:
    """Idempotent: an item without a photo is a no-op (no audit entry)."""
    old = (item.image_key, item.thumb_key)
    if not any(old):
        return
    item.image_key = item.thumb_key = None
    audit.record(db, p, "item.image_delete", "menu_item", item.id, {"image": old[0]})
    db.commit()
    _delete(item.restaurant_id, *old)
