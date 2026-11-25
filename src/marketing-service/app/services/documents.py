"""Onboarding document upload: validation (type by content signature, size) and a storage interface.

Bytes never go in the database; `DocumentStore` is the seam for S3/GCS. `LocalDiskStore` is the default,
`MemoryStore` is for tests. Files are served back only through an authenticated endpoint, with nosniff."""
import hashlib
import re
import uuid
from pathlib import Path
from typing import Protocol

from fastapi import HTTPException

from app.core.config import settings

# content signature -> canonical content type
SIGNATURES = [(b"%PDF-", "application/pdf"), (b"\x89PNG\r\n\x1a\n", "image/png"), (b"\xff\xd8\xff", "image/jpeg")]
EXTENSIONS = {"application/pdf": {".pdf"}, "image/png": {".png"}, "image/jpeg": {".jpg", ".jpeg"}}


class DocumentStore(Protocol):
    def put(self, key: str, data: bytes) -> None: ...

    def get(self, key: str) -> bytes: ...

    def delete(self, key: str) -> None: ...


class MemoryStore:
    def __init__(self):
        self.blobs: dict[str, bytes] = {}

    def put(self, key, data):
        self.blobs[key] = data

    def get(self, key):
        return self.blobs[key]

    def delete(self, key):
        self.blobs.pop(key, None)


class LocalDiskStore:
    def __init__(self, root: str):
        self.root = Path(root)

    def _path(self, key: str) -> Path:
        if not re.fullmatch(r"[0-9a-f-]{36}", key):  # keys are generated UUIDs; never a caller-supplied path
            raise ValueError("bad storage key")
        return self.root / key

    def put(self, key, data):
        self.root.mkdir(parents=True, exist_ok=True)
        self._path(key).write_bytes(data)

    def get(self, key):
        return self._path(key).read_bytes()

    def delete(self, key):
        self._path(key).unlink(missing_ok=True)


_store: DocumentStore | None = None


def get_document_store() -> DocumentStore:
    """FastAPI dependency; tests override it with MemoryStore."""
    global _store
    if _store is None:
        _store = LocalDiskStore(settings.document_storage_dir)
    return _store


def sniff(data: bytes) -> str | None:
    return next((ct for sig, ct in SIGNATURES if data.startswith(sig)), None)


def clean_filename(name: str) -> str:
    base = re.split(r"[\\/]", name)[-1]
    base = re.sub(r"[^\w.\- ]", "_", base).strip(" .")
    return base[:120] or "document"


def validate(filename: str, declared_type: str | None, data: bytes) -> tuple[str, str]:
    """Return (clean filename, content type) or raise 4xx. The signature decides the type; the extension and the
    declared Content-Type must agree with it."""
    if not data:
        raise HTTPException(422, "Empty file")
    if len(data) > settings.document_max_bytes:
        raise HTTPException(413, f"File too large (max {settings.document_max_bytes // (1024 * 1024)} MB)")
    ct = sniff(data)
    if ct is None:
        raise HTTPException(415, "Unsupported file type: only PDF, PNG and JPEG are accepted")
    name = clean_filename(filename)
    if Path(name).suffix.lower() not in EXTENSIONS[ct]:
        raise HTTPException(415, "File extension does not match its content")
    if declared_type and declared_type.split(";")[0].strip().lower() not in (ct, "application/octet-stream"):
        raise HTTPException(415, "Declared content type does not match the file")
    return name, ct


def new_key() -> str:
    return str(uuid.uuid4())


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()
