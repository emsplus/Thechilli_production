"""Stock locations, wastage, batches, counts, purchase orders, goods receipts, purchase returns, supplier ledger, negative
stock and recipe cost (docs/INVENTORY.md). Reads are gated like the writes of their area: nothing here is open to every role."""
import uuid
from datetime import date

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.orm import Session

from app.api.deps import P, Principal, require_perm
from app.core.db import get_db
from app.schemas.stock import (
    BatchOut, ConversionOut, ConversionsIn, CountLinesIn, CountOpenIn, CountOut, GRNIn, GRNLinkIn, GRNOut, LedgerEntryOut, LocationIn,
    LocationOut, LocationPatch, NegativeStockOut, POIn, POOut, POPatch, RecipeCostOut, ReturnIn, ReturnOut, SupplierEntryIn,
    SupplierLedgerOut, WastageIn, WastageOut, WriteOffIn,
)
from app.services import inventory as inv, procurement, stock, stock_locations

router = APIRouter(tags=["stock"])
READ_STOCK = (P.INVENTORY_MANAGE, P.PURCHASES_MANAGE, P.PURCHASES_RECEIVE, P.INVENTORY_COUNT, P.WASTAGE_RECORD)
Page = dict(limit=Query(100, ge=1, le=500), offset=Query(0, ge=0))


# ---- locations
@router.get("/stock/locations", response_model=list[LocationOut])
def list_locations(include_inactive: bool = False, p: Principal = Depends(require_perm(*READ_STOCK)), db: Session = Depends(get_db)):
    return stock_locations.list_for(db, p, include_inactive)


@router.post("/stock/locations", response_model=LocationOut, status_code=201)
def create_location(data: LocationIn, p: Principal = Depends(require_perm(P.INVENTORY_MANAGE)), db: Session = Depends(get_db)):
    return stock_locations.create(db, p, data.name, data.kind)


@router.patch("/stock/locations/{location_id}", response_model=LocationOut)
def patch_location(location_id: uuid.UUID, data: LocationPatch, p: Principal = Depends(require_perm(P.INVENTORY_MANAGE)),
                   db: Session = Depends(get_db)):
    return stock_locations.update(db, p, location_id, data.name, data.kind, data.is_active)


# ---- unit conversions
@router.get("/inventory/items/{item_id}/conversions", response_model=list[ConversionOut])
def get_conversions(item_id: uuid.UUID, p: Principal = Depends(require_perm(*READ_STOCK)), db: Session = Depends(get_db)):
    return stock.get_conversions(db, p, item_id)


@router.put("/inventory/items/{item_id}/conversions", response_model=list[ConversionOut])
def put_conversions(item_id: uuid.UUID, data: ConversionsIn, p: Principal = Depends(require_perm(P.INVENTORY_MANAGE)),
                    db: Session = Depends(get_db)):
    return stock.set_conversions(db, p, item_id, [(c.unit_code, c.factor_to_base) for c in data.conversions])


# ---- wastage, batches
@router.post("/inventory/wastage", response_model=WastageOut, status_code=201)
def post_wastage(data: WastageIn, response: Response, p: Principal = Depends(require_perm(P.WASTAGE_RECORD)),
                 db: Session = Depends(get_db)):
    ms, replayed = stock.record_wastage(db, p, data.idempotency_key, data.item_id, data.quantity, data.unit, data.reason_code,
                                        data.note, data.location_id, data.batch_id)
    if replayed:
        response.status_code = 200
    return {"replayed": replayed, "movements": [{**{k: getattr(m, k) for k in ("id", "item_id", "location_id", "batch_id", "quantity",
                                                                              "reason_code")}, "movement_type": m.movement_type.value} for m in ms]}


@router.get("/inventory/wastage")
def wastage_report(date_from: date | None = None, date_to: date | None = None, location_id: uuid.UUID | None = None,
                   p: Principal = Depends(require_perm(P.INVENTORY_MANAGE, P.WASTAGE_RECORD)), db: Session = Depends(get_db)):
    return stock.wastage_report(db, p, date_from, date_to, location_id)


@router.get("/stock/batches", response_model=list[BatchOut])
def list_batches(item_id: uuid.UUID | None = None, location_id: uuid.UUID | None = None,
                 expiring_within_days: int | None = Query(None, ge=0, le=3650), expired: bool = False, include_empty: bool = False,
                 limit: int = Query(200, ge=1, le=500), offset: int = Query(0, ge=0),
                 p: Principal = Depends(require_perm(P.INVENTORY_MANAGE, P.WASTAGE_RECORD, P.PURCHASES_RECEIVE)), db: Session = Depends(get_db)):
    return stock.list_batches(db, p, item_id, location_id, expiring_within_days, include_empty, expired, limit, offset)


@router.post("/stock/batches/{batch_id}/write-off", status_code=201)
def write_off(batch_id: uuid.UUID, data: WriteOffIn, p: Principal = Depends(require_perm(P.WASTAGE_RECORD)), db: Session = Depends(get_db)):
    m = stock.write_off_batch(db, p, batch_id, data.idempotency_key, data.note)
    return {"status": "ok", "replayed": m is None}


# ---- counts
@router.post("/stock/counts", response_model=CountOut, status_code=201)
def open_count(data: CountOpenIn, p: Principal = Depends(require_perm(P.INVENTORY_COUNT)), db: Session = Depends(get_db)):
    return stock.open_count(db, p, data.name, data.location_id)


@router.get("/stock/counts", response_model=list[CountOut])
def list_counts(limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0),
                p: Principal = Depends(require_perm(P.INVENTORY_COUNT, P.INVENTORY_MANAGE)), db: Session = Depends(get_db)):
    return stock.list_counts(db, p, limit, offset)


@router.get("/stock/counts/{count_id}", response_model=CountOut)
def get_count(count_id: uuid.UUID, p: Principal = Depends(require_perm(P.INVENTORY_COUNT, P.INVENTORY_MANAGE)), db: Session = Depends(get_db)):
    return stock.get_count(db, p, count_id)


@router.put("/stock/counts/{count_id}/lines", response_model=CountOut)
def put_count_lines(count_id: uuid.UUID, data: CountLinesIn, p: Principal = Depends(require_perm(P.INVENTORY_COUNT)),
                    db: Session = Depends(get_db)):
    return stock.set_count_lines(db, p, count_id, [(l.item_id, l.counted, l.unit) for l in data.lines])


@router.post("/stock/counts/{count_id}/post", response_model=CountOut)
def post_count(count_id: uuid.UUID, p: Principal = Depends(require_perm(P.INVENTORY_COUNT)), db: Session = Depends(get_db)):
    return stock.post_count(db, p, count_id)


# ---- reports
@router.get("/inventory/negative-stock", response_model=list[NegativeStockOut])
def negative_stock(p: Principal = Depends(require_perm(P.INVENTORY_MANAGE)), db: Session = Depends(get_db)):
    return stock.negative_stock(db, p)


@router.get("/recipes/{menu_item_id}/cost", response_model=RecipeCostOut)
def recipe_cost(menu_item_id: uuid.UUID, p: Principal = Depends(require_perm(P.INVENTORY_MANAGE)), db: Session = Depends(get_db)):
    return stock.recipe_cost(db, p, menu_item_id)


# ---- purchase orders
@router.post("/purchase-orders", response_model=POOut, status_code=201)
def create_po(data: POIn, p: Principal = Depends(require_perm(P.PURCHASES_MANAGE)), db: Session = Depends(get_db)):
    return procurement.create_po(db, p, data)


@router.get("/purchase-orders", response_model=list[POOut])
def list_pos(status: str | None = Query(None, pattern="^(draft|sent|partially_received|closed|cancelled)$"),
             supplier_id: uuid.UUID | None = None, limit: int = Query(100, ge=1, le=500), offset: int = Query(0, ge=0),
             p: Principal = Depends(require_perm(P.PURCHASES_MANAGE, P.PURCHASES_RECEIVE)), db: Session = Depends(get_db)):
    return procurement.list_pos(db, p, status, supplier_id, limit, offset)


@router.get("/purchase-orders/{po_id}", response_model=POOut)
def get_po(po_id: uuid.UUID, p: Principal = Depends(require_perm(P.PURCHASES_MANAGE, P.PURCHASES_RECEIVE)), db: Session = Depends(get_db)):
    return procurement.get_po(db, p, po_id)


@router.put("/purchase-orders/{po_id}", response_model=POOut)
def update_po(po_id: uuid.UUID, data: POPatch, p: Principal = Depends(require_perm(P.PURCHASES_MANAGE)), db: Session = Depends(get_db)):
    return procurement.update_po(db, p, po_id, data)


@router.post("/purchase-orders/{po_id}/send", response_model=POOut)
def send_po(po_id: uuid.UUID, p: Principal = Depends(require_perm(P.PURCHASES_MANAGE)), db: Session = Depends(get_db)):
    return procurement.send_po(db, p, po_id)


@router.post("/purchase-orders/{po_id}/cancel", response_model=POOut)
def cancel_po(po_id: uuid.UUID, p: Principal = Depends(require_perm(P.PURCHASES_MANAGE)), db: Session = Depends(get_db)):
    return procurement.cancel_po(db, p, po_id)


@router.post("/purchase-orders/{po_id}/close", response_model=POOut)
def close_po(po_id: uuid.UUID, p: Principal = Depends(require_perm(P.PURCHASES_MANAGE)), db: Session = Depends(get_db)):
    return procurement.close_po(db, p, po_id)


# ---- goods receipts
@router.post("/purchase-orders/{po_id}/receipts", response_model=GRNOut, status_code=201)
def receive(po_id: uuid.UUID, data: GRNIn, response: Response, p: Principal = Depends(require_perm(P.PURCHASES_RECEIVE)),
            db: Session = Depends(get_db)):
    grn, replayed = procurement.receive(db, p, po_id, data)
    if replayed:
        response.status_code = 200
    return grn


@router.get("/goods-receipts", response_model=list[GRNOut])
def list_grns(po_id: uuid.UUID | None = None, supplier_id: uuid.UUID | None = None, purchase_invoice_id: uuid.UUID | None = None,
              limit: int = Query(100, ge=1, le=500),
              offset: int = Query(0, ge=0), p: Principal = Depends(require_perm(P.PURCHASES_RECEIVE, P.PURCHASES_MANAGE)),
              db: Session = Depends(get_db)):
    """`purchase_invoice_id`: only the GRNs linked to that scanned supplier bill (PO <-> GRN <-> purchase bill)."""
    return procurement.list_grns(db, p, po_id, supplier_id, limit, offset, purchase_invoice_id)


@router.post("/goods-receipts/{grn_id}/link-purchase", response_model=GRNOut)
def link_grn_purchase(grn_id: uuid.UUID, data: GRNLinkIn, p: Principal = Depends(require_perm(P.PURCHASES_MANAGE)),
                      db: Session = Depends(get_db)):
    """Adds the supplier's bill number to a GRN saved without it and/or links the bill scanned under Purchases, so that
    confirming the bill does not add the same goods again. Idempotent; 409 if that bill's stock was already added from the
    scan (docs/INVENTORY.md "Supplier bills and GRNs")."""
    return procurement.link_purchase(db, p, grn_id, data)


@router.get("/purchases/{invoice_id}/goods-receipt-candidates", response_model=list[GRNOut])
def grn_candidates(invoice_id: uuid.UUID, p: Principal = Depends(require_perm(P.PURCHASES_MANAGE)), db: Session = Depends(get_db)):
    """Unlinked GRNs of the bill's supplier (no bill number or the same one, received within 30 days of the bill date):
    the deliveries this scanned bill may already be booked on. Link one before confirming the bill."""
    return procurement.grn_candidates(db, p, invoice_id)


@router.get("/goods-receipts/{grn_id}", response_model=GRNOut)
def get_grn(grn_id: uuid.UUID, p: Principal = Depends(require_perm(P.PURCHASES_RECEIVE, P.PURCHASES_MANAGE)), db: Session = Depends(get_db)):
    return procurement.get_grn(db, p, grn_id)


# ---- purchase returns
@router.post("/purchase-returns", response_model=ReturnOut, status_code=201)
def create_return(data: ReturnIn, response: Response, p: Principal = Depends(require_perm(P.PURCHASES_MANAGE)), db: Session = Depends(get_db)):
    ret, replayed = procurement.create_return(db, p, data)
    if replayed:
        response.status_code = 200
    return ret


@router.get("/purchase-returns", response_model=list[ReturnOut])
def list_returns(limit: int = Query(100, ge=1, le=500), offset: int = Query(0, ge=0),
                 p: Principal = Depends(require_perm(P.PURCHASES_MANAGE)), db: Session = Depends(get_db)):
    return procurement.list_returns(db, p, limit, offset)


@router.get("/purchase-returns/{return_id}", response_model=ReturnOut)
def get_return(return_id: uuid.UUID, p: Principal = Depends(require_perm(P.PURCHASES_MANAGE)), db: Session = Depends(get_db)):
    return procurement.get_return(db, p, return_id)


# ---- supplier ledger
@router.get("/suppliers/{supplier_id}/ledger", response_model=SupplierLedgerOut)
def supplier_ledger(supplier_id: uuid.UUID, limit: int = Query(100, ge=1, le=500), offset: int = Query(0, ge=0),
                    p: Principal = Depends(require_perm(P.PURCHASES_MANAGE)), db: Session = Depends(get_db)):
    return procurement.supplier_ledger(db, p, supplier_id, limit, offset)


@router.post("/suppliers/{supplier_id}/ledger", response_model=LedgerEntryOut, status_code=201)
def supplier_entry(supplier_id: uuid.UUID, data: SupplierEntryIn, response: Response,
                   p: Principal = Depends(require_perm(P.PURCHASES_MANAGE)), db: Session = Depends(get_db)):
    """Records a payment to the supplier (reduces the balance) or a signed adjustment. Idempotent on idempotency_key."""
    e, replayed = procurement.record_supplier_entry(db, p, supplier_id, data.idempotency_key, data.kind, data.amount, data.note, data.entry_date)
    if replayed:
        response.status_code = 200
    return {"id": e.id, "entry_type": e.entry_type, "amount": e.amount, "entry_date": e.entry_date, "ref_type": e.ref_type,
            "ref_id": e.ref_id, "note": e.note, "created_at": e.created_at, "running_balance": procurement.supplier_ledger(db, p, supplier_id, 1, 0)["balance"]}
