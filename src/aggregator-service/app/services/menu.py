from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import MenuMapping, StoreMapping
from app.services.outbox import enqueue


def _store(s: Session, tenant_id, outlet_id, provider) -> StoreMapping | None:
    return s.scalar(select(StoreMapping).where(StoreMapping.tenant_id == tenant_id, StoreMapping.outlet_id == outlet_id,
                                               StoreMapping.provider == provider, StoreMapping.active.is_(True)))


def enqueue_menu_sync(s: Session, tenant_id: str, outlet_id: str, provider: str, items: list[dict], version: str):
    """items: internal [{internal_item_id,name,price_minor,available}]. Items with no mapping for this provider are
    returned as `unmapped` (reported to the caller, never silently dropped)."""
    store = _store(s, tenant_id, outlet_id, provider)
    if store is None:
        return None, [i["internal_item_id"] for i in items]
    maps = {m.internal_item_id: m.external_item_id for m in s.scalars(select(MenuMapping).where(
        MenuMapping.tenant_id == tenant_id, MenuMapping.outlet_id == outlet_id, MenuMapping.provider == provider))}
    out, unmapped = [], []
    for i in items:
        ext = maps.get(i["internal_item_id"])
        if ext is None:
            unmapped.append(i["internal_item_id"])
        else:
            out.append({"external_item_id": ext, "name": i["name"], "price_minor": i["price_minor"],
                        "available": i.get("available", True)})
    job = enqueue(s, kind="menu_sync", tenant_id=tenant_id, provider=provider,
                  key=f"menu_sync:{outlet_id}:{provider}:{version}",
                  payload={"external_store_id": store.external_store_id, "items": out}) if out else None
    return job, unmapped


def enqueue_availability(s: Session, tenant_id: str, outlet_id: str, internal_item_id: str, available: bool, version: str):
    """Fan out to every provider that maps this item. Returns (providers_queued, providers_without_mapping)."""
    queued = []
    for m in s.scalars(select(MenuMapping).where(MenuMapping.tenant_id == tenant_id, MenuMapping.outlet_id == outlet_id,
                                                 MenuMapping.internal_item_id == internal_item_id)):
        store = _store(s, tenant_id, outlet_id, m.provider)
        if store is None:
            continue
        enqueue(s, kind="set_availability", tenant_id=tenant_id, provider=m.provider,
                key=f"avail:{outlet_id}:{m.provider}:{m.external_item_id}:{version}",
                payload={"external_store_id": store.external_store_id, "external_item_id": m.external_item_id,
                         "available": available})
        queued.append(m.provider)
    return queued
