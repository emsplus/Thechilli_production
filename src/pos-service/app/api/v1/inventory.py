import uuid
from decimal import Decimal

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, Query, UploadFile
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.deps import require_feature, current_principal, P, Principal, require_perm
from app.core.db import get_db
from app.models.core import Alert, InventoryItem, MovementType, Recipe, StockMovement, Supplier, SupplierEmail
from app.schemas.inventory import (
    AdjustIn, BulkItemsIn, BulkItemsOut, CountIn, CountResultOut, InventoryItemIn, InventoryItemOut, InventoryItemPatch, MovementOut, ReorderEmailInfo,
    PurchaseDraftIn, PurchaseOut, RecipeIn, RecipeOut, RecipeVersionOut, SupplierIn, SupplierOut, SupplierPatch,
)
from app.services import audit, inventory as inv, manage, purchases as pur, reorder, stock_import, stock_sources
from app.services.ocr import Extractor, get_extractor

router = APIRouter(tags=["inventory"], dependencies=[Depends(require_feature("inventory"))])


def _items_out(db: Session, p: Principal, items: list[InventoryItem]) -> list[InventoryItemOut]:
    ids = [i.id for i in items]
    bal = inv.balances(db, p.restaurant_id, ids)  # per-item column kept by the ledger trigger: no ledger scan
    lr = stock_sources.last_received(db, p.restaurant_id, ids)
    names = {s.id: s.name for s in db.scalars(select(Supplier).where(
        Supplier.restaurant_id == p.restaurant_id, Supplier.id.in_({i.supplier_id for i in items if i.supplier_id})))} if items else {}
    emailed = {}
    if ids and p.can(P.INVENTORY_MANAGE):
        for item_id, e in db.execute(select(Alert.item_id, SupplierEmail).join(SupplierEmail, SupplierEmail.id == Alert.supplier_email_id)
                                     .where(Alert.restaurant_id == p.restaurant_id, Alert.status == "open", Alert.kind == "low_stock",
                                            Alert.item_id.in_(ids))):
            emailed[item_id] = ReorderEmailInfo(id=e.id, status=e.status, kind=e.kind, at=e.sent_at or e.created_at)
    out = []
    for i in items:
        o = InventoryItemOut.model_validate(i)
        o.last_received = lr.get(i.id)
        o.balance = bal.get(i.id, Decimal(0))
        o.low_stock = o.balance <= i.reorder_level
        o.supplier_name = names.get(i.supplier_id)
        o.suggested_quantity = reorder.suggest_quantity(i, o.balance)
        o.reorder_email = emailed.get(i.id)
        out.append(o)
    return out


@router.get("/inventory/items", response_model=list[InventoryItemOut])
def list_items(include_inactive: bool = False, limit: int = Query(2000, ge=1, le=5000), offset: int = Query(0, ge=0),
               p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """Active items, by name, paginated (`limit` / `offset`); `include_inactive` (owner/manager only) also lists archived ones."""
    q = select(InventoryItem).where(InventoryItem.restaurant_id == p.restaurant_id)
    if not (include_inactive and p.can(P.INVENTORY_MANAGE)):
        q = q.where(InventoryItem.is_active)
    return _items_out(db, p, db.scalars(q.order_by(InventoryItem.name, InventoryItem.id).limit(limit).offset(offset)).all())


@router.get("/inventory/low-stock", response_model=list[InventoryItemOut])
def low_stock(limit: int = Query(2000, ge=1, le=5000), offset: int = Query(0, ge=0),
              p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    q = select(InventoryItem).where(InventoryItem.restaurant_id == p.restaurant_id, InventoryItem.is_active,
                                    InventoryItem.balance <= InventoryItem.reorder_level)  # filtered in SQL on the balance column
    return _items_out(db, p, db.scalars(q.order_by(InventoryItem.name, InventoryItem.id).limit(limit).offset(offset)).all())


@router.post("/inventory/items", response_model=InventoryItemOut, status_code=201)
def create_item(data: InventoryItemIn, p: Principal = Depends(require_perm(P.INVENTORY_MANAGE)), db: Session = Depends(get_db)):
    if db.scalar(select(InventoryItem).where(InventoryItem.restaurant_id == p.restaurant_id,
                                             InventoryItem.name == data.name)):
        raise HTTPException(409, "Inventory item already exists")
    fields = data.model_dump(exclude={"supplier_id", "reorder_quantity", "reorder_unit"})
    fields["sku"] = fields["sku"] or None
    if fields["sku"] and db.scalar(select(InventoryItem.id).where(InventoryItem.restaurant_id == p.restaurant_id,
                                                                  InventoryItem.sku == fields["sku"])):
        raise HTTPException(409, "SKU already used by another item")
    extra = manage.reorder_fields(db, p, data.base_unit, {k: getattr(data, k) for k in ("supplier_id", "reorder_quantity", "reorder_unit")
                                                          if k in data.model_fields_set})
    item = InventoryItem(restaurant_id=p.restaurant_id, **fields, **extra)
    db.add(item)
    db.flush()
    audit.record(db, p, "inventory_item.create", "inventory_item", item.id)
    db.commit()
    return _items_out(db, p, [item])[0]


@router.post("/inventory/items/bulk", response_model=BulkItemsOut, status_code=201)
def bulk_create_items(data: BulkItemsIn, p: Principal = Depends(require_perm(P.INVENTORY_MANAGE)), db: Session = Depends(get_db)):
    """Creates many stock items atomically (spreadsheet import, invoice lines). Existing names come back in `existing`
    (409 when `strict`). `opening_quantity` posts ONE adjustment per new item; replaying the key posts nothing twice."""
    r = stock_import.bulk_create(db, p, data)
    return {"created": _items_out(db, p, r["created"]), "existing": _items_out(db, p, r["existing"]),
            "movements": r["movements"], "replayed": r["replayed"]}


@router.patch("/inventory/items/{item_id}", response_model=InventoryItemOut)
def patch_item(item_id: uuid.UUID, data: InventoryItemPatch, p: Principal = Depends(require_perm(P.INVENTORY_MANAGE)),
               db: Session = Depends(get_db)):
    item = manage.patch_inventory_item(db, p, item_id, data)
    return _items_out(db, p, [item])[0]


@router.get("/inventory/ledger", response_model=list[MovementOut])
def ledger(item_id: uuid.UUID | None = None, movement_type: MovementType | None = None,
           location_id: uuid.UUID | None = None, batch_id: uuid.UUID | None = None, reason_code: str | None = None,
           before: str | None = Query(None, description="cursor: the created_at of the last row of the previous page"),
           limit: int = Query(500, ge=1, le=500), p: Principal = Depends(require_perm(P.INVENTORY_MANAGE)),
           db: Session = Depends(get_db)):
    """Newest first. Every row carries a server-resolved `source` (invoice / bill / reason / count)."""
    from app.services.reports import Ctx
    Ctx.for_principal(db, p).require_tenant_level("The stock ledger")  # stock carries no outlet
    return stock_sources.ledger(db, p.restaurant_id, item_id, movement_type, limit, location_id=location_id, batch_id=batch_id,
                                reason_code=reason_code, before=before)


@router.post("/inventory/adjustments", status_code=201)
def adjust(data: AdjustIn, p: Principal = Depends(require_perm(P.INVENTORY_MANAGE)), db: Session = Depends(get_db)):
    inv.adjust(db, p, data.idempotency_key, data.item_id, data.quantity, data.unit, data.kind, data.reason)
    return {"status": "ok"}


@router.post("/inventory/counts", response_model=list[CountResultOut], status_code=201)
def count(data: CountIn, p: Principal = Depends(require_perm(P.INVENTORY_MANAGE)), db: Session = Depends(get_db)):
    return inv.stock_count(db, p, data.idempotency_key, [(l.item_id, l.counted, l.unit) for l in data.lines])


@router.post("/recipes", response_model=RecipeOut, status_code=201)
def create_recipe(data: RecipeIn, p: Principal = Depends(require_perm(P.INVENTORY_MANAGE)), db: Session = Depends(get_db)):
    return inv.create_recipe(db, p, data.menu_item_id, [(i.item_id, i.quantity, i.unit) for i in data.ingredients])


@router.get("/recipes", response_model=list[RecipeOut])
def list_recipes(menu_item_id: uuid.UUID | None = None, p: Principal = Depends(require_perm(P.INVENTORY_MANAGE)),
                 db: Session = Depends(get_db)):
    q = select(Recipe).where(Recipe.restaurant_id == p.restaurant_id, Recipe.effective_to.is_(None))
    if menu_item_id:
        q = q.where(Recipe.menu_item_id == menu_item_id)
    return db.scalars(q).all()


@router.get("/recipes/{menu_item_id}/history", response_model=list[RecipeVersionOut])
def recipe_history(menu_item_id: uuid.UUID, p: Principal = Depends(require_perm(P.INVENTORY_MANAGE)), db: Session = Depends(get_db)):
    """Every version of a dish's recipe, newest first (the current one has effective_to = null)."""
    return manage.recipe_history(db, p, menu_item_id)


@router.get("/suppliers", response_model=list[SupplierOut])
def list_suppliers(include_inactive: bool = False, p: Principal = Depends(require_perm(P.PURCHASES_MANAGE, P.INVENTORY_MANAGE)),
                   db: Session = Depends(get_db)):
    q = select(Supplier).where(Supplier.restaurant_id == p.restaurant_id)
    if not (include_inactive and p.can(P.INVENTORY_MANAGE)):
        q = q.where(Supplier.is_active)
    return db.scalars(q.order_by(Supplier.name)).all()


@router.patch("/suppliers/{supplier_id}", response_model=SupplierOut)
def patch_supplier(supplier_id: uuid.UUID, data: SupplierPatch, p: Principal = Depends(require_perm(P.PURCHASES_MANAGE)),
                   db: Session = Depends(get_db)):
    return manage.patch_supplier(db, p, supplier_id, data)


@router.post("/suppliers", response_model=SupplierOut, status_code=201)
def create_supplier(data: SupplierIn, p: Principal = Depends(require_perm(P.PURCHASES_MANAGE)), db: Session = Depends(get_db)):
    fields = data.model_dump()
    fields["trn"] = manage.check_supplier_tax_number(db, p, data.trn)
    fields["phone"] = manage.check_supplier_phone(db, p, data.phone)
    s = Supplier(restaurant_id=p.restaurant_id, **fields)
    db.add(s)
    try:
        db.flush()
        audit.record(db, p, "supplier.create", "supplier", s.id, {"name": data.name})
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "Supplier already exists")
    return s


@router.post("/purchases", response_model=PurchaseOut, status_code=202)
def upload_purchase(background: BackgroundTasks, file: UploadFile = File(...),
                    supplier_id: uuid.UUID | None = Form(default=None),
                    p: Principal = Depends(require_perm(P.PURCHASES_MANAGE)), db: Session = Depends(get_db),
                    extractor: Extractor = Depends(get_extractor)):
    data = file.file.read(10 * 1024 * 1024 + 1)
    invoice = pur.store_upload(db, p, data, file.content_type or "", supplier_id)
    background.add_task(pur.run_extraction, p.restaurant_id, invoice.id, extractor)
    return stock_sources.purchases_out(db, p.restaurant_id, [invoice])[0]


@router.post("/purchases/pages", response_model=PurchaseOut, status_code=202)
def upload_purchase_pages(background: BackgroundTasks, pages: list[UploadFile] = File(...),
                          supplier_id: uuid.UUID | None = Form(default=None),
                          p: Principal = Depends(require_perm(P.PURCHASES_MANAGE)), db: Session = Depends(get_db),
                          extractor: Extractor = Depends(get_extractor)):
    """A bill photographed page by page (phone camera): the photos become ONE purchase (stored as one PDF, read in one
    OCR call). Up to 10 JPG/PNG/WebP pages, 10 MB together."""
    if supplier_id:
        manage.usable_supplier(db, p, supplier_id)  # fail fast, before the CPU work
    if len(pages) > pur.MAX_PAGES:
        raise HTTPException(422, f"Too many pages: a bill can have up to {pur.MAX_PAGES} photos")
    read = [(f.file.read(10 * 1024 * 1024 + 1), f.content_type or "") for f in pages]
    pdf, sha = pur.combine_pages(read)
    invoice = pur.store_upload(db, p, pdf, "application/pdf", supplier_id, sha=sha)
    background.add_task(pur.run_extraction, p.restaurant_id, invoice.id, extractor)
    return stock_sources.purchases_out(db, p.restaurant_id, [invoice])[0]


@router.get("/purchases", response_model=list[PurchaseOut])
def list_purchases(p: Principal = Depends(require_perm(P.PURCHASES_MANAGE)), db: Session = Depends(get_db)):
    from app.models.core import PurchaseInvoice
    rows = db.scalars(select(PurchaseInvoice).where(PurchaseInvoice.restaurant_id == p.restaurant_id)
                      .order_by(PurchaseInvoice.created_at.desc()).limit(200)).all()
    return stock_sources.purchases_out(db, p.restaurant_id, list(rows))


@router.get("/purchases/{invoice_id}", response_model=PurchaseOut)
def get_purchase(invoice_id: uuid.UUID, p: Principal = Depends(require_perm(P.PURCHASES_MANAGE)), db: Session = Depends(get_db)):
    return stock_sources.purchases_out(db, p.restaurant_id, [pur.load(db, p, invoice_id)])[0]


@router.put("/purchases/{invoice_id}", response_model=PurchaseOut)
def edit_purchase(invoice_id: uuid.UUID, data: PurchaseDraftIn, p: Principal = Depends(require_perm(P.PURCHASES_MANAGE)),
                  db: Session = Depends(get_db)):
    return stock_sources.purchases_out(db, p.restaurant_id, [pur.update_draft(db, p, invoice_id, data)])[0]


@router.post("/purchases/{invoice_id}/resolve-supplier", response_model=PurchaseOut)
def resolve_supplier(invoice_id: uuid.UUID, p: Principal = Depends(require_perm(P.PURCHASES_MANAGE)), db: Session = Depends(get_db)):
    """Selects (or creates, once) the supplier the scanned bill names. Safe to call again."""
    return stock_sources.purchases_out(db, p.restaurant_id, [pur.resolve_invoice_supplier(db, p, invoice_id)])[0]


@router.post("/purchases/{invoice_id}/retry-extraction", response_model=PurchaseOut, status_code=202)
def retry_extraction(invoice_id: uuid.UUID, background: BackgroundTasks,
                     p: Principal = Depends(require_perm(P.PURCHASES_MANAGE)), db: Session = Depends(get_db),
                     extractor: Extractor = Depends(get_extractor)):
    """Re-reads a failed invoice, or one stuck in `uploaded` (lost background job). 409 otherwise."""
    invoice = pur.retry_extraction(db, p, invoice_id)
    background.add_task(pur.run_extraction, p.restaurant_id, invoice.id, extractor)
    return invoice


@router.post("/purchases/{invoice_id}/confirm", response_model=PurchaseOut)
def confirm_purchase(invoice_id: uuid.UUID, p: Principal = Depends(require_perm(P.PURCHASES_MANAGE)),
                     db: Session = Depends(get_db)):
    return stock_sources.purchases_out(db, p.restaurant_id, [pur.confirm(db, p, invoice_id)])[0]
