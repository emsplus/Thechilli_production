from fastapi import APIRouter

from app.api.v1 import admin, public, public_link, webhooks

router = APIRouter()
router.include_router(admin.router)
router.include_router(public.router)
router.include_router(public_link.admin)
router.include_router(public_link.public)
router.include_router(webhooks.router)


@router.get("/health")
def health():
    return {"status": "ok"}
