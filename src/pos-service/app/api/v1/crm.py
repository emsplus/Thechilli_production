import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.deps import current_principal, P, Principal, require_feature, require_perm
from app.core.db import get_db
from app.models.core import Alert, Bill, ConsentRecord, Customer, Device, Order
from app.schemas.crm import (
    AlertOut, ConsentIn, ConsentState, CustomerIn, CustomerOut, CustomerPatch, HeartbeatIn, HistoryBill, normalize_phone,
)
from app.services import audit, outlets

router = APIRouter(tags=["crm"])
customers_module = Depends(require_feature("customers"))  # Manage > Features: Customers (alerts / heartbeat below are not part of it)


def _consents(db: Session, customer_ids: list[uuid.UUID]) -> dict[uuid.UUID, list[ConsentState]]:
    out: dict[uuid.UUID, dict] = {}
    q = select(ConsentRecord).where(ConsentRecord.customer_id.in_(customer_ids)).order_by(ConsentRecord.recorded_at)
    for r in db.scalars(q):  # later rows overwrite earlier => latest state per channel
        out.setdefault(r.customer_id, {})[r.channel] = ConsentState(
            channel=r.channel, granted=r.granted, source=r.source, recorded_at=r.recorded_at)
    return {k: list(v.values()) for k, v in out.items()}


def _out(db: Session, customers: list[Customer]) -> list[CustomerOut]:
    ids = [c.id for c in customers]
    cons = _consents(db, ids) if ids else {}
    stats = {r[0]: r for r in db.execute(
        select(Order.customer_id, func.count(Bill.id), func.coalesce(func.sum(Bill.total), 0), func.max(Bill.finalized_at))
        .join(Bill, Bill.order_id == Order.id).where(Order.customer_id.in_(ids), Bill.status == "active").group_by(Order.customer_id))} if ids else {}
    res = []
    for c in customers:
        o = CustomerOut.model_validate(c)
        o.consents = cons.get(c.id, [])
        if c.id in stats:
            o.orders, o.total_spent, o.last_visit = stats[c.id][1], stats[c.id][2], stats[c.id][3]
        res.append(o)
    return res


def _get(db: Session, p: Principal, cid: uuid.UUID) -> Customer:
    c = db.get(Customer, cid)
    if not c or c.restaurant_id != p.restaurant_id:
        raise HTTPException(404, "Customer not found")
    return c


@router.get("/customers", response_model=list[CustomerOut], dependencies=[customers_module])
def list_customers(q: str | None = None, p: Principal = Depends(require_perm(P.CRM_READ)), db: Session = Depends(get_db)):
    stmt = select(Customer).where(Customer.restaurant_id == p.restaurant_id)
    if q:
        term = q.strip()
        try:
            phone_term = normalize_phone(term)
        except ValueError:
            phone_term = term
        stmt = stmt.where(Customer.name.ilike(f"%{term}%") | Customer.phone.like(f"%{phone_term.lstrip('+')}%"))
    return _out(db, list(db.scalars(stmt.order_by(func.coalesce(Customer.name, Customer.phone)).limit(100))))


@router.post("/customers", response_model=CustomerOut, status_code=201, dependencies=[customers_module])
def create_customer(data: CustomerIn, p: Principal = Depends(require_perm(P.CRM_WRITE)), db: Session = Depends(get_db)):
    fields = data.model_dump()
    if data.phone is not None:
        try:
            fields["phone"] = normalize_phone(data.phone)
        except ValueError as e:
            raise HTTPException(422, str(e))
    c = Customer(restaurant_id=p.restaurant_id, **fields)
    db.add(c)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "A customer with this phone number already exists")
    audit.record(db, p, "customer.create", "customer", c.id)
    db.commit()
    return _out(db, [c])[0]


@router.patch("/customers/{cid}", response_model=CustomerOut, dependencies=[customers_module])
def update_customer(cid: uuid.UUID, data: CustomerPatch, p: Principal = Depends(require_perm(P.CRM_WRITE)),
                    db: Session = Depends(get_db)):
    """Correct a customer's name / phone / email / notes. Consent history and past bills are untouched."""
    c = _get(db, p, cid)
    fields = data.model_dump(exclude_unset=True)
    if fields.get("phone") is not None:
        try:
            fields["phone"] = normalize_phone(fields["phone"])
        except ValueError as e:
            raise HTTPException(422, str(e))
    if "notes" in fields and isinstance(fields["notes"], str):
        fields["notes"] = fields["notes"].strip() or None
    if ("name" in fields and fields["name"] is None or "name" not in fields and c.name is None) and \
       ("phone" in fields and fields["phone"] is None or "phone" not in fields and c.phone is None):
        raise HTTPException(422, "Enter a name or a phone number (or both)")
    changed = {k: v for k, v in fields.items() if getattr(c, k) != v}
    for k, v in changed.items():
        setattr(c, k, v)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "A customer with this phone number already exists")
    if changed:
        audit.record(db, p, "customer.update", "customer", c.id, {"fields": sorted(changed)})
    db.commit()
    return _out(db, [c])[0]


@router.post("/customers/{cid}/erase", dependencies=[customers_module])
def erase_customer(cid: uuid.UUID, p: Principal = Depends(require_perm(P.SETTINGS_OWNER)), db: Session = Depends(get_db)):
    """Owner only. Right to erasure (DPDP; security review finding 9): anonymises the customer's personal data while the
    bills (GST records) stay. The customer row keeps its id (orders still point at it) but loses name, phone, email, notes;
    the name / phone snapshots on its bills, reservations made with its phone, the restaurant's delivery orders for that
    phone and queued / sent WhatsApp messages to it are cleared. The buyer's GSTIN on a B2B invoice is a statutory field and
    stays on the bill. Irreversible; audited without the erased values. NEEDS LEGAL REVIEW for retention periods."""
    from sqlalchemy import delete, update
    from app.models.core import DeliveryOrder, WhatsAppOutbox
    from app.models.frontdesk import Reservation
    c = _get(db, p, cid)
    phone, rid = c.phone, p.restaurant_id
    order_ids = select(Order.id).where(Order.restaurant_id == rid, Order.customer_id == c.id)
    n_bills = db.execute(update(Bill).where(Bill.restaurant_id == rid, Bill.order_id.in_(order_ids))
                         .values(customer_name=None, customer_phone=None)).rowcount
    n_res = n_del = n_wa = 0
    if phone:
        n_res = db.execute(update(Reservation).where(Reservation.restaurant_id == rid, Reservation.phone == phone)
                           .values(guest_name="Erased guest", phone=None, notes=None)).rowcount
        n_del = db.execute(update(DeliveryOrder).where(DeliveryOrder.restaurant_id == rid, DeliveryOrder.customer_phone == phone)
                           .values(customer_name="Erased customer", customer_phone=None, address_text="Erased")).rowcount
        n_wa = db.execute(delete(WhatsAppOutbox).where(WhatsAppOutbox.restaurant_id == rid, WhatsAppOutbox.to_phone == phone)).rowcount
    c.name, c.phone, c.email, c.notes = "Erased customer", None, None, None
    audit.record(db, p, "customer.erase", "customer", c.id,
                 {"bills": n_bills, "reservations": n_res, "delivery_orders": n_del, "whatsapp_messages": n_wa})
    db.commit()
    return {"id": str(c.id), "erased": True, "bills_anonymised": n_bills, "reservations_anonymised": n_res,
            "delivery_orders_anonymised": n_del, "whatsapp_messages_deleted": n_wa}


@router.post("/customers/{cid}/consent", response_model=CustomerOut, status_code=201, dependencies=[customers_module])
def record_consent(cid: uuid.UUID, data: ConsentIn, p: Principal = Depends(require_perm(P.CRM_WRITE)),
                   db: Session = Depends(get_db)):
    """Append-only: withdrawing creates a new record; history is never edited or deleted."""
    c = _get(db, p, cid)
    db.add(ConsentRecord(restaurant_id=p.restaurant_id, customer_id=c.id, channel=data.channel,
                         granted=data.granted, source=data.source, recorded_by=p.user_id))
    audit.record(db, p, "consent.granted" if data.granted else "consent.withdrawn", "customer", c.id,
                 {"channel": data.channel.value, "source": data.source})
    db.commit()
    return _out(db, [c])[0]


@router.get("/customers/{cid}/history", response_model=list[HistoryBill], dependencies=[customers_module])
def history(cid: uuid.UUID, p: Principal = Depends(require_perm(P.CRM_READ)), db: Session = Depends(get_db)):
    c = _get(db, p, cid)
    bills = db.scalars(select(Bill).join(Order, Order.id == Bill.order_id).where(Order.customer_id == c.id, Bill.status == "active")
                       .order_by(Bill.finalized_at.desc()).limit(100)).all()
    return [HistoryBill(invoice_number=b.invoice_number, finalized_at=b.finalized_at, total=b.total,
                        items=[f"{l.quantity} x {l.description}" for l in b.lines]) for b in bills]


@router.get("/alerts", response_model=list[AlertOut])
def list_alerts(status: str | None = None, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    q = select(Alert).where(Alert.restaurant_id == p.restaurant_id)
    if status:
        q = q.where(Alert.status == status)
    return db.scalars(q.order_by(Alert.created_at.desc()).limit(200)).all()


@router.post("/sync/heartbeat", status_code=204)
def heartbeat(data: HeartbeatIn, p: Principal = Depends(require_perm(P.SYNC_PUSH)), db: Session = Depends(get_db)):
    """Devices report how many offline operations are still unsynced, so reports can flag incomplete data."""
    d = db.scalar(select(Device).where(Device.restaurant_id == p.restaurant_id, Device.device_key == data.device_key))
    now = datetime.now(timezone.utc)
    if d:
        d.pending_ops, d.last_seen_at = data.pending_ops, now
    else:
        db.add(Device(restaurant_id=p.restaurant_id, outlet_id=outlets.outlet_of(db, p), device_key=data.device_key, name=data.name or "Chilli Agent device",
                      pending_ops=data.pending_ops, last_seen_at=now))
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
