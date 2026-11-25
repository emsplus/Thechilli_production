"""Bills that are not stock. Recording one never touches the stock ledger."""
import uuid
from datetime import date, datetime
from decimal import Decimal

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.core import Expense, PurchaseInvoice, PurchaseStatus
from app.schemas.expenses import ExpenseBucket, ExpenseIn, ExpensePatch, ExpenseSummary
from app.services import audit, manage

PAISA = Decimal("0.01")


def _gross(net: Decimal, vat: Decimal, given: Decimal | None) -> Decimal:
    gross = (net + vat).quantize(PAISA)
    if given is not None and abs(given - gross) > PAISA:
        raise HTTPException(422, f"Gross {given} does not equal net {net} + tax {vat}")
    return gross


def _dup(db: Session, p, name: str, number: str | None, ignore: uuid.UUID | None = None) -> None:
    if not number:
        return
    q = select(Expense.id).where(Expense.restaurant_id == p.restaurant_id, func.lower(Expense.supplier_name) == name.lower(),
                                 Expense.invoice_number == number)
    if ignore:
        q = q.where(Expense.id != ignore)
    if db.scalar(q.limit(1)):
        raise HTTPException(409, f"Invoice {number} from {name} is already recorded as an expense")


def create(db: Session, p, data: ExpenseIn) -> Expense:
    name = " ".join(data.supplier_name.split())
    number = (data.invoice_number or "").strip() or None
    if data.supplier_id:
        manage.usable_supplier(db, p, data.supplier_id)
    _dup(db, p, name, number)
    inv = None
    if data.invoice_id:
        inv = db.get(PurchaseInvoice, data.invoice_id, with_for_update=True)
        if not inv or inv.restaurant_id != p.restaurant_id:
            raise HTTPException(404, "Purchase invoice not found")
        if inv.status == PurchaseStatus.confirmed and inv.document_type != "expense":
            raise HTTPException(409, "This invoice already added stock; it cannot also be an expense")
        if db.scalar(select(Expense.id).where(Expense.invoice_id == inv.id).limit(1)):
            raise HTTPException(409, "This invoice is already recorded as an expense")
        from app.services.purchases import require_inr  # local import: purchases imports a lot
        require_inr(inv.extracted_json)  # a bill read in another currency needs rupee amounts first
    e = Expense(restaurant_id=p.restaurant_id, supplier_id=data.supplier_id, supplier_name=name, invoice_number=number,
                expense_date=data.expense_date, category=data.category, net=data.net.quantize(PAISA),
                vat=data.vat.quantize(PAISA), gross=_gross(data.net, data.vat, data.gross), note=data.note,
                invoice_id=data.invoice_id, created_by=p.user_id)
    db.add(e)
    if inv:  # the scan is filed under expenses and leaves the "waiting for review" list; no stock is posted
        inv.document_type, inv.status = "expense", PurchaseStatus.confirmed
        inv.confirmed_by, inv.confirmed_at = p.user_id, datetime.now().astimezone()
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, f"Invoice {number} from {name} is already recorded as an expense")
    audit.record(db, p, "expense.create", "expense", e.id, {"supplier": name, "invoice_number": number, "gross": str(e.gross), "category": e.category})
    db.commit()
    return e


def get(db: Session, p, expense_id: uuid.UUID, lock: bool = False) -> Expense:
    e = db.get(Expense, expense_id, with_for_update=lock)
    if not e or e.restaurant_id != p.restaurant_id:
        raise HTTPException(404, "Expense not found")
    return e


def update(db: Session, p, expense_id: uuid.UUID, data: ExpensePatch) -> Expense:
    e = get(db, p, expense_id, lock=True)
    sent = data.model_dump(exclude_unset=True)
    if "supplier_id" in sent and sent["supplier_id"]:
        manage.usable_supplier(db, p, sent["supplier_id"], keep=e.supplier_id)
    name = " ".join(sent["supplier_name"].split()) if sent.get("supplier_name") else e.supplier_name
    number = ((sent.get("invoice_number") or "").strip() or None) if "invoice_number" in sent else e.invoice_number
    _dup(db, p, name, number, ignore=e.id)
    old = {k: str(getattr(e, k)) for k in ("supplier_name", "invoice_number", "expense_date", "category", "net", "vat", "note")}
    for k in ("supplier_id", "expense_date", "category", "note"):
        if k in sent and not (sent[k] is None and k in ("expense_date", "category")):
            setattr(e, k, sent[k])
    e.supplier_name, e.invoice_number = name, number
    net = sent["net"] if sent.get("net") is not None else e.net
    vat = sent["vat"] if sent.get("vat") is not None else e.vat
    e.net, e.vat, e.gross = net.quantize(PAISA), vat.quantize(PAISA), _gross(net, vat, None)
    audit.record(db, p, "expense.update", "expense", e.id, {"before": old})
    db.commit()
    return e


def _guard(db: Session, p) -> None:
    """Expenses carry no outlet: an outlet-restricted user must not read the tenant-wide totals."""
    from app.services.reports import Ctx
    Ctx.for_principal(db, p).require_tenant_level("Expenses")


def _filters(p, start: date | None, end: date | None, category: str | None = None) -> list:
    f = [Expense.restaurant_id == p.restaurant_id]
    if start:
        f.append(Expense.expense_date >= start)
    if end:
        f.append(Expense.expense_date <= end)
    if category:
        f.append(Expense.category == category)
    return f


def listing(db: Session, p, start: date | None, end: date | None, category: str | None, limit: int = 1000, offset: int = 0) -> list[Expense]:
    _guard(db, p)
    q = select(Expense).where(*_filters(p, start, end, category))
    return list(db.scalars(q.order_by(Expense.expense_date.desc(), Expense.created_at.desc(), Expense.id)
                           .limit(min(max(limit, 1), 1000)).offset(max(offset, 0))))


def summary(db: Session, p, start: date | None, end: date | None) -> ExpenseSummary:
    """Grouped in SQL (no row cap): by month, by category and in total."""
    _guard(db, p)
    where = _filters(p, start, end)

    def bucket(key_expr) -> list[ExpenseBucket]:
        rows = db.execute(select(key_expr, func.count(Expense.id), func.sum(Expense.net), func.sum(Expense.vat), func.sum(Expense.gross))
                          .where(*where).group_by(key_expr).order_by(key_expr.desc())).all()
        return [ExpenseBucket(key=k, count=n, net=a, vat=b, gross=g) for k, n, a, b, g in rows]
    n, net, vat, gross = db.execute(select(func.count(Expense.id), func.coalesce(func.sum(Expense.net), 0),
                                           func.coalesce(func.sum(Expense.vat), 0), func.coalesce(func.sum(Expense.gross), 0)).where(*where)).one()
    return ExpenseSummary(months=bucket(func.to_char(Expense.expense_date, "YYYY-MM")), categories=bucket(Expense.category),
                          total=ExpenseBucket(key="total", count=n, net=net, vat=vat, gross=gross))
