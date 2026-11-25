import hashlib
import logging
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy import func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.db import SessionLocal
from app.core.tenancy import tenant_session
from app.models.core import (
    MovementType, PurchaseInvoice, PurchaseLine, PurchaseStatus, Supplier,
)
from app.services.ocr import Extracted, ExtractedLine
from app.services import alerts, audit, gemini, inventory, manage
from app.services.billing import money
from app.services.localisation import normalise_tax_number
from app.services.ocr import Extractor
from app.services.packs import derive, parse_uk_date
from app.services.units import normalize_code, to_base

log = logging.getLogger("pos.purchases")

ALLOWED = {"application/pdf", "image/png", "image/jpeg", "image/webp"}


PAGE_TYPES = {"image/png", "image/jpeg", "image/webp"}
MAX_PAGES = 10
PAGE_MAX_SIDE = 2000  # same as the OCR step's MAX_SIDE: enough for small print, keeps the PDF small


def combine_pages(pages: list[tuple[bytes, str]]) -> tuple[bytes, str]:
    """Phone photos of a multi-page bill -> ONE PDF (one page per photo, EXIF-uprighted, <= 2000 px, JPEG inside), so the
    rest of the pipeline (storage, duplicate check, retry, Gemini) treats it exactly like an uploaded PDF.
    Returns (pdf bytes, fingerprint); the fingerprint hashes the original photos, so re-sending the same photos is a
    duplicate even though PDF bytes are not byte-for-byte reproducible."""
    if not pages:
        raise HTTPException(422, "Add at least one page")
    if len(pages) > MAX_PAGES:
        raise HTTPException(422, f"Too many pages: a bill can have up to {MAX_PAGES} photos")
    total = sum(len(d) for d, _ in pages)
    if total > settings.max_upload_bytes:
        raise HTTPException(413, f"The photos are too large together (limit {settings.max_upload_bytes // (1024 * 1024)} MB). "
                                 "Retake them or send fewer pages")
    import io

    from PIL import Image, ImageOps
    images = []
    for n, (data, ctype) in enumerate(pages, start=1):
        if ctype not in PAGE_TYPES:
            kind = "HEIC" if "hei" in ctype else (ctype or "unknown")
            raise HTTPException(415, f"Page {n} is a {kind} file. Use JPG, PNG or WebP photos (the camera button takes JPG)")
        if not data:
            raise HTTPException(413, f"Page {n} is empty")
        try:
            img = Image.open(io.BytesIO(data))
            img.draft("RGB", (PAGE_MAX_SIDE, PAGE_MAX_SIDE))  # JPEG: decode at reduced size (fast, little memory)
            img = ImageOps.exif_transpose(img).convert("RGB")
            img.thumbnail((PAGE_MAX_SIDE, PAGE_MAX_SIDE))
        except Exception:
            raise HTTPException(422, f"Page {n} could not be read as an image. Take that photo again")
        images.append(img)
    out = io.BytesIO()
    images[0].save(out, "PDF", save_all=True, append_images=images[1:], resolution=150, quality=85)
    fingerprint = hashlib.sha256(b"".join(hashlib.sha256(d).digest() for d, _ in pages)).hexdigest()
    return out.getvalue(), fingerprint


_MAGIC = {"image/png": "PNG", "image/jpeg": "JPEG", "image/webp": "WEBP"}


def sniffed_type(data: bytes) -> str | None:
    """The content type the bytes really are (magic bytes), whatever the client said. Security review finding 12: HTML
    labelled image/png was accepted."""
    if data.startswith(b"%PDF-"):
        return "application/pdf"
    from app.services.menu_images import sniff
    fmt = sniff(data)
    return next((ct for ct, f in _MAGIC.items() if f == fmt), None)


def store_upload(db: Session, p, data: bytes, content_type: str, supplier_id: uuid.UUID | None,
                 sha: str | None = None) -> PurchaseInvoice:
    if content_type not in ALLOWED:
        raise HTTPException(415, "Upload a PDF, PNG, JPEG or WebP file")
    if not data or len(data) > settings.max_upload_bytes:
        raise HTTPException(413, "File is empty or too large")
    if sniffed_type(data) != content_type:
        raise HTTPException(415, "The file content does not match its type. Upload a PDF, PNG, JPEG or WebP file")
    if supplier_id:
        manage.usable_supplier(db, p, supplier_id)
    sha = sha or hashlib.sha256(data).hexdigest()
    dup = db.scalar(select(PurchaseInvoice).where(
        PurchaseInvoice.restaurant_id == p.restaurant_id, PurchaseInvoice.file_sha256 == sha))
    if dup:
        raise HTTPException(409, f"This file was already uploaded (invoice {dup.id})")
    d = Path(settings.storage_dir) / str(p.restaurant_id)
    d.mkdir(parents=True, exist_ok=True)
    path = d / f"{uuid.uuid4()}.bin"  # server-chosen name; client filename is never used
    path.write_bytes(data)
    inv = PurchaseInvoice(restaurant_id=p.restaurant_id, supplier_id=supplier_id, file_path=str(path),
                          content_type=content_type, file_sha256=sha)
    db.add(inv)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        path.unlink(missing_ok=True)
        raise HTTPException(409, "This file was already uploaded")
    audit.record(db, p, "purchase.upload", "purchase_invoice", inv.id)
    db.commit()
    return inv


def _s(d) -> str | None:
    return None if d is None else f"{d:f}"


def reconcile_amounts(qty: Decimal, price: Decimal, total: Decimal) -> tuple[Decimal, Decimal, str | None]:
    """Quantity x unit price should equal the line amount. Two systematic misreads are repaired in code:
    - price and amount columns swapped (the 'unit price' is the amount and the 'amount' is the price): swap back;
    - amount differs from qty x price (discount column, misread digit): keep the PRINTED amount, which the invoice
      net is the sum of, and restate the price from it. The note makes the line show up under "need attention"."""
    if qty <= 0 or total <= 0 or price <= 0:
        return price, total, None
    slack = max(Decimal("0.02"), total * Decimal("0.005"))
    if abs(qty * price - total) <= slack:
        return price, total, None
    if qty > 1 and abs(price - qty * total) <= max(Decimal("0.02"), price * Decimal("0.005")):
        return total, price, "Unit price and amount looked swapped; put back in the right columns"
    new_price = (total / qty).quantize(Decimal("0.0001"))
    return new_price, total, f"Printed price {price:f} x {qty:f} is {money(qty * price):f}, but the line amount is {total:f}; price restated from the amount"


def build_line(i: int, l: ExtractedLine, stock: bool = True) -> PurchaseLine:
    """One OCR line -> a draft line. The stock quantity is derived HERE (qty x pack x size), never taken from the model;
    when it cannot be derived the line keeps what was printed and is flagged `needs_check` (confirm refuses it).

    The printed quantity, unit and price are never silently replaced by a derivation that comes only from the
    description text: "Gulab Jamun (2 pcs)" x 1 @ 120.00 stays 1 @ 120.00, and what one unit would add to stock is offered
    in pack.per_unit for the person to apply. The same holds for every line of a document that is not (yet) a stock
    purchase (`stock=False`): the lines are listed exactly as printed. Pack COLUMNS and printed units of measure (kg, l)
    are read as before. A line with no printed unit gets the neutral unit "pcs", never "case"."""
    price0, total0, note = reconcile_amounts(l.quantity, l.unit_price, l.line_total)
    l = l.model_copy(update={"unit_price": price0, "line_total": total0})
    r = derive(l.description, l.quantity, l.unit, l.pack_count, l.unit_size, l.unit_size_unit, l.pack_text)
    printed_unit = normalize_code(l.unit) if l.unit.strip() else ""
    qty, unit, price = l.quantity, printed_unit, l.unit_price
    from_text_only = r["status"] == "ok" and r["source"] == "description"
    hint = r["status"] == "ok" and r["per_unit"] and from_text_only and (
        not stock or (r["per_unit"]["unit"] == "pcs" and not printed_unit))
    if hint:
        unit = printed_unit or "pcs"
    elif r["status"] in ("ok", "asis"):
        qty, unit = r["quantity"], r["unit"]
        if r["status"] == "ok" and qty > 0:
            price = (l.line_total / qty).quantize(Decimal("0.0001"))
    else:
        unit = printed_unit or r["unit"] or "pcs"
    if hint or r["status"] != "asis" or r["measure"] or note:
        pack = {"status": "hint" if hint else r["status"], "text": r["text"], "count_total": r["count_total"], "measure": r["measure"],
                "options": r["options"], "invoiced": {"quantity": _s(l.quantity), "unit": l.unit, "unit_price": _s(l.unit_price)},
                "pack_count": _s(l.pack_count), "unit_size": _s(l.unit_size), "unit_size_unit": l.unit_size_unit, "pack_text": l.pack_text,
                "price_note": note, "per_unit": r["per_unit"] if hint else None}
    else:
        pack = None
    needs_check = r["status"] == "uncertain"
    return PurchaseLine(position=i, description=l.description, quantity=qty, unit=unit[:20], unit_price=price,
                        line_total=l.line_total, confidence=l.confidence, pack=pack,
                        needs_check=needs_check, check_reason=r["reason"],
                        item_code=(l.item_code or None) and l.item_code[:50], vat_code=(l.vat_code or None) and l.vat_code[:10],
                        vat_rate=l.vat_rate)


# ---- supplier read from the bill: match an existing one, or create it (once) ----
_SUPPLIER_NOISE = {"the", "and", "ltd", "limited", "llc", "plc", "inc", "pvt", "private", "co", "company", "restaurant", "restaurants",
                   "cafe", "cafes", "bar", "grill", "kitchen", "foods", "food", "trading", "llp", "lp"}
_KEEP_UPPER = {"LLC", "LLP", "PLC", "GST", "LP", "HUF", "OPC"}
_SMALL = {"and", "of", "the", "&"}


def supplier_key(name: str | None) -> str:
    """'THE URBAN PLATE RESTAURANT & CAFE LTD.' and 'Urban Plate' share a key: case, accents, punctuation, 'Ltd',
    'Restaurant & Cafe' and a leading 'The' do not make a different supplier."""
    import re
    import unicodedata
    t = unicodedata.normalize("NFKD", (name or "").lower().replace("&", " and "))
    t = "".join(c for c in t if not unicodedata.combining(c))
    words = re.findall(r"[a-z0-9]+", t)
    core = [w for w in words if w not in _SUPPLIER_NOISE]
    return " ".join(core or words)


def tidy_supplier_name(name: str) -> str:
    """Name as printed, tidy-cased: 'THE URBAN PLATE' -> 'The Urban Plate'. Mixed-case names are left alone (only spaces tidied)."""
    import re
    n = re.sub(r"\s+", " ", name or "").strip(" ,;:-")
    letters = [c for c in n if c.isalpha()]
    if not letters or not (all(c.isupper() for c in letters) or all(c.islower() for c in letters)):
        return n
    out = []
    for k, w in enumerate(n.split(" ")):
        if w.upper().strip(".,") in _KEEP_UPPER:
            out.append(w.upper())
        elif k and w.lower() in _SMALL:
            out.append(w.lower())
        else:
            out.append("-".join(x[:1].upper() + x[1:].lower() for x in w.split("-")))
    return " ".join(out)


def _supplier_tax_number(db: Session, restaurant_id: uuid.UUID, value: str | None) -> str | None:
    """The bill's tax number if it is a valid GSTIN; else None (the supplier is still created, without it)."""
    from app.schemas.common import check_tax_number
    if not (value or "").strip():
        return None
    try:
        return check_tax_number(value)
    except ValueError:
        return None


def _phone(db: Session, restaurant_id: uuid.UUID, value: str | None) -> str | None:
    """The bill's supplier phone as E.164 (+91 for a bare Indian number); anything that is not a usable number is dropped."""
    from app.schemas.crm import normalize_phone
    v = (value or "").strip()
    if sum(c.isdigit() for c in v) < 6:
        return None
    try:
        return normalize_phone(v)
    except ValueError:
        return None


def _email(value: str | None) -> str | None:
    from app.schemas.inventory import check_email
    try:
        return check_email(value)
    except ValueError:
        return None


def _fill_contacts(db: Session, restaurant_id: uuid.UUID, sup: Supplier, phone: str | None, email: str | None) -> None:
    """The bill may know the supplier's phone / email: fill the fields that are EMPTY, never overwrite what the owner typed."""
    from types import SimpleNamespace
    changes = {}
    if not sup.phone and (v := _phone(db, restaurant_id, phone)):
        changes["phone"] = {"old": None, "new": v}
    if not sup.email and (v := _email(email)):
        changes["email"] = {"old": None, "new": v}
    if changes:
        for k, c in changes.items():
            setattr(sup, k, c["new"])
        audit.record(db, SimpleNamespace(restaurant_id=restaurant_id, user_id=None), "supplier.update", "supplier", sup.id,
                     {**changes, "source": "invoice"})


def resolve_supplier(db: Session, restaurant_id: uuid.UUID, name: str | None, tax_number: str | None = None,
                     phone: str | None = None, email: str | None = None) -> tuple[Supplier | None, bool]:
    """-> (supplier, created). Finds the tenant's active supplier that the bill names (exact name, same name after
    case/punctuation/'Ltd'/'Restaurant & Cafe' are ignored, one unambiguous containment, or the same tax number) and
    otherwise creates it. Idempotent and race-safe: suppliers are resolved one at a time per restaurant (advisory lock held
    to the end of the transaction) and the name is unique per restaurant. Never matches another restaurant's supplier."""
    raw = tidy_supplier_name(name or "")
    if len(raw) < 2:
        return None, False
    db.execute(select(func.pg_advisory_xact_lock(func.hashtextextended(f"supplier:{restaurant_id}", 0))))
    rows = list(db.scalars(select(Supplier).where(Supplier.restaurant_id == restaurant_id)))
    live = [x for x in rows if x.is_active]
    key = supplier_key(raw)
    sup = next((x for x in live if x.name.strip().lower() == raw.lower()), None) \
        or next((x for x in live if key and supplier_key(x.name) == key), None)
    if not sup:  # "AL NOOR FOODSTUFF TRADING LLC" vs saved "Al Noor Foodstuff": one unambiguous containment match
        low = raw.lower()
        cands = [x for x in live if len(x.name.strip()) >= 4 and (x.name.strip().lower() in low or low in x.name.strip().lower())]
        sup = cands[0] if len(cands) == 1 else None
    want = normalise_tax_number(tax_number) if tax_number else None
    if not sup and want:
        sup = next((x for x in live if x.trn and normalise_tax_number(x.trn) == want), None)
    if sup:
        _fill_contacts(db, restaurant_id, sup, phone, email)
        return sup, False
    if any(x.name.strip().lower() == raw.lower() or (key and supplier_key(x.name) == key) for x in rows):
        return None, False  # an archived supplier of that name exists: do not resurrect or duplicate it
    s = Supplier(restaurant_id=restaurant_id, name=raw[:200], trn=_supplier_tax_number(db, restaurant_id, tax_number), phone=_phone(db, restaurant_id, phone),
                 email=_email(email))
    db.add(s)
    db.flush()
    from types import SimpleNamespace
    audit.record(db, SimpleNamespace(restaurant_id=restaurant_id, user_id=None), "supplier.create", "supplier", s.id,
                 {"name": s.name, "source": "invoice"})
    return s, True


# A bill printed in another currency (ocr.currency_code read a symbol / code other than the rupee): the amounts read are
# NOT rupees. The foreign code is never stored; the invoice carries this flag until a person enters INR amounts
# (PUT /purchases/{id} with amounts_in_inr=true), and it cannot be confirmed or recorded as an expense before that.
NOT_INR_CODE = "not_inr"
NOT_INR_TEXT = "not INR: needs manual conversion"


def not_inr(ex: dict | None) -> bool:
    return bool(ex) and ex.get("currency_flag") == NOT_INR_CODE


def currency_warning(ex: dict | None) -> dict | None:
    return {"code": NOT_INR_CODE, "message": NOT_INR_TEXT} if not_inr(ex) else None


def require_inr(ex: dict | None) -> None:
    """409 (error.code not_inr) while the invoice is flagged as printed in another currency."""
    if not_inr(ex):
        e = HTTPException(409, f"This bill is {NOT_INR_TEXT}. Enter the amounts in rupees (INR) and save them with "
                               "amounts_in_inr=true before confirming")
        e.code = NOT_INR_CODE  # app/core/errors.py -> error.code
        raise e


def stored_reading(ex: Extracted) -> dict:
    """The raw OCR reading as stored for audit: currency is only ever 'INR' or null; a bill read in another currency is
    flagged instead (the foreign code is dropped)."""
    data = ex.model_dump(mode="json")
    if ex.currency not in (None, "INR"):
        data["currency"], data["currency_flag"] = None, NOT_INR_CODE
    return data


def bill_view(ex: dict | None) -> dict | None:
    """The printed header/footer details of the bill that have no column of their own (stored in the raw OCR JSON).
    Shown on the review screen as printed; never used to compute anything."""
    if not ex:
        return None
    pick = lambda k: (str(ex[k]).strip() or None) if ex.get(k) not in (None, "") else None  # noqa: E731
    out = {"currency": "INR" if pick("currency") == "INR" else None, "supplier_address": pick("supplier_address"), "supplier_phone": pick("supplier_phone"),
           "supplier_email": pick("supplier_email"), "time": pick("invoice_time_text"), "table": pick("table_no"),
           "order_type": pick("order_type"), "payment": pick("payment_method"), "amount_in_words": pick("amount_in_words"),
           "tax_lines": [{"label": str(t.get("label") or "").strip(), "rate": t.get("rate"), "amount": str(t.get("amount"))}
                         for t in (ex.get("tax_lines") or []) if t.get("amount") is not None]}
    return out if any(v for v in out.values()) else None


DOC_TYPES = {"stock_purchase", "expense", "other"}


def scan_error_text(e: BaseException) -> str:
    """What the owner sees when reading an invoice failed: a plain sentence, never an exception text or a variable name (those
    go to the log as a type only; the scan can hold supplier and personal data)."""
    if isinstance(e, gemini.AiError):
        return str(e.detail)
    log.warning("invoice scan failed: %s", type(e).__name__)
    return gemini.owner_text("ocr", gemini.UNAVAILABLE)


def run_extraction(tenant_id: uuid.UUID, invoice_id: uuid.UUID, extractor: Extractor) -> None:
    """Background job. Writes extracted values as an editable DRAFT only; never touches stock.
    No transaction is held during the slow OCR call; the result is written under a row lock and only if the
    invoice is still `uploaded`, so a duplicate run (retry / restart recovery racing a live job) cannot
    overwrite a finished extraction or a human's edits."""
    with tenant_session(tenant_id) as db:
        inv = db.get(PurchaseInvoice, invoice_id)
        if not inv or inv.restaurant_id != tenant_id or inv.status != PurchaseStatus.uploaded:
            return
        path, content_type = inv.file_path, inv.content_type
        db.rollback()
        ex, error = None, None
        try:
            ex = extractor.extract(Path(path).read_bytes(), content_type)
        except Exception as e:  # network, quota, bad JSON, schema violation, missing file
            error = scan_error_text(e)
        inv = db.get(PurchaseInvoice, invoice_id, with_for_update=True, populate_existing=True)
        if not inv or inv.status != PurchaseStatus.uploaded:
            return
        if error is not None:
            inv.status, inv.error = PurchaseStatus.failed, error
            db.commit()
            return
        inv.extracted_json = stored_reading(ex)
        # Indian invoices are day-first; the date as printed beats the model's own ISO conversion.
        inv.invoice_number, inv.invoice_date, inv.total = ex.invoice_number, parse_uk_date(ex.invoice_date_text) or ex.invoice_date, ex.total
        inv.net, inv.vat, inv.supplier_vat_number = ex.net, ex.vat, (ex.supplier_vat_number or "").strip()[:30] or None
        inv.document_type = ex.document_type if ex.document_type in DOC_TYPES else "stock_purchase"
        inv.confidence = ex.confidence
        inv.supplier_name_raw = (ex.supplier_name or "").strip()[:200] or None
        if not inv.supplier_id and ex.supplier_name:
            sup, _ = resolve_supplier(db, inv.restaurant_id, ex.supplier_name, inv.supplier_vat_number, ex.supplier_phone, ex.supplier_email)
            inv.supplier_id = sup.id if sup else None
        inv.lines = [build_line(i, l, stock=inv.document_type == "stock_purchase") for i, l in enumerate(ex.lines)]
        if inv.document_type != "stock_purchase":  # an expense has no stock quantities to verify
            for l in inv.lines:
                l.needs_check, l.check_reason = False, None
        inv.status, inv.error = PurchaseStatus.extracted, None
        db.commit()


# ---- recovery of lost extraction jobs (BackgroundTasks die with the process) ----
# `updated_at` doubles as the claim timestamp: queueing a job (upload, retry, recovery) sets it to now, and an
# invoice still `uploaded` after `extraction_stale_minutes` is presumed to have lost its job.

def _stale_after() -> timedelta:
    return timedelta(minutes=settings.extraction_stale_minutes)


def is_stale(inv: PurchaseInvoice) -> bool:
    return inv.updated_at is not None and inv.updated_at < datetime.now(timezone.utc) - _stale_after()


def retry_extraction(db: Session, p, invoice_id: uuid.UUID) -> PurchaseInvoice:
    """Re-queues OCR for a failed invoice or one stuck in `uploaded`. The caller schedules run_extraction."""
    inv = load(db, p, invoice_id, lock=True)
    if not inv.retry_extraction_allowed:
        if inv.status == PurchaseStatus.uploaded:
            raise HTTPException(409, f"This invoice is still being read; retry is possible after "
                                     f"{settings.extraction_stale_minutes} minutes")
        raise HTTPException(409, f"Purchase is {inv.status.value}; only failed or stuck invoices can be re-read")
    previous = inv.status.value
    inv.status, inv.error = PurchaseStatus.uploaded, None
    inv.updated_at = func.now()  # renews the claim even when the status does not change
    audit.record(db, p, "purchase.retry_extraction", "purchase_invoice", inv.id, {"previous_status": previous})
    db.commit()
    db.refresh(inv)
    return inv


def claim_stale_with_tenants(db: Session, limit: int = 50) -> list[tuple[uuid.UUID, uuid.UUID]]:
    """Claims invoices stuck in `uploaded` by renewing their updated_at; returns (invoice id, tenant id), oldest first.
    FOR UPDATE SKIP LOCKED gives concurrent replicas disjoint rows, and once committed the renewed timestamp keeps them from
    being claimed again. Cross-tenant by design, so it is a SECURITY DEFINER function (app/core/definer.py)."""
    rows = db.execute(text("SELECT id, tenant_id FROM claim_stale_purchases(:n, :m)"),
                      {"n": limit, "m": settings.extraction_stale_minutes}).all()
    db.commit()
    return [(r.id, r.tenant_id) for r in rows]


def claim_stale(db: Session, limit: int = 50) -> list[uuid.UUID]:
    return [i for i, _ in claim_stale_with_tenants(db, limit)]


def recover_stuck_extractions(extractor: Extractor) -> int:
    """Run on API startup: re-runs extraction for invoices whose background job was lost."""
    with SessionLocal() as db:
        claimed = claim_stale_with_tenants(db)
    for invoice_id, tenant_id in claimed:
        run_extraction(tenant_id, invoice_id, extractor)
    return len(claimed)


def load(db: Session, p, invoice_id: uuid.UUID, lock: bool = False) -> PurchaseInvoice:
    inv = db.get(PurchaseInvoice, invoice_id, with_for_update=lock)
    if not inv or inv.restaurant_id != p.restaurant_id:
        raise HTTPException(404, "Purchase invoice not found")
    return inv


def update_draft(db: Session, p, invoice_id: uuid.UUID, data) -> PurchaseInvoice:
    inv = load(db, p, invoice_id, lock=True)
    if inv.status == PurchaseStatus.confirmed:
        raise HTTPException(409, "Confirmed purchases cannot be edited")
    if data.supplier_id:
        manage.usable_supplier(db, p, data.supplier_id, keep=inv.supplier_id)
    new_lines = []
    for i, l in enumerate(data.lines):
        if l.item_id:
            inventory.get_item(db, p, l.item_id)
        total = money(l.quantity * l.unit_price)
        if l.line_total is not None:  # exact total survives a 4-decimal unit price (pack conversion)
            slack = l.quantity * Decimal("0.00005") + Decimal("0.005")
            if abs(l.line_total - l.quantity * l.unit_price) <= slack:
                total = money(l.line_total)
        new_lines.append(PurchaseLine(position=i, description=l.description, item_id=None if l.exclude_from_stock else l.item_id,
                                      quantity=l.quantity, unit=normalize_code(l.unit),
                                      unit_price=l.unit_price, line_total=total, pack=l.pack, needs_check=l.needs_check,
                                      check_reason=l.check_reason if l.needs_check else None,
                                      exclude_from_stock=l.exclude_from_stock, item_code=l.item_code, vat_code=l.vat_code,
                                      vat_rate=l.vat_rate))
    inv.supplier_id, inv.invoice_number, inv.invoice_date = data.supplier_id, data.invoice_number, data.invoice_date
    inv.lines = new_lines
    converted = bool(getattr(data, "amounts_in_inr", False)) and not_inr(inv.extracted_json)
    if converted:  # a person entered rupee amounts: the foreign totals read from the bill no longer apply
        inv.extracted_json = {k: v for k, v in inv.extracted_json.items() if k != "currency_flag"}
        inv.total = sum((l.line_total for l in new_lines), Decimal("0"))
        inv.net = inv.vat = None
    if data.document_type:
        inv.document_type = data.document_type
    if inv.total is None:  # an OCR-read invoice total (gross, printed) is evidence; only a hand-typed invoice gets a computed one
        inv.total = sum((l.line_total for l in new_lines), Decimal("0"))
    if inv.status == PurchaseStatus.failed:
        inv.status = PurchaseStatus.extracted  # manual entry rescues a failed extraction
    audit.record(db, p, "purchase.edit", "purchase_invoice", inv.id, {"amounts_in_inr": True} if converted else None)
    db.commit()
    return inv


def resolve_invoice_supplier(db: Session, p, invoice_id: uuid.UUID) -> PurchaseInvoice:
    """Review screen, first open: an invoice that has no supplier yet gets the one its bill names (matched or created).
    Idempotent: a second call, a retry or a second tab finds the supplier the first one made. Confirmed invoices stay as they are."""
    inv = load(db, p, invoice_id, lock=True)
    if inv.supplier_id or inv.status == PurchaseStatus.confirmed or not inv.supplier_name_raw:
        return inv
    ex = inv.extracted_json or {}
    sup, created = resolve_supplier(db, p.restaurant_id, inv.supplier_name_raw, inv.supplier_vat_number, ex.get("supplier_phone"), ex.get("supplier_email"))
    if sup:
        inv.supplier_id = sup.id
        audit.record(db, p, "purchase.supplier_resolved", "purchase_invoice", inv.id, {"supplier_id": str(sup.id), "created": created})
    db.commit()
    return inv


def bill_no_key(number: str | None) -> str | None:
    """Supplier bill number as compared for duplicates: case and whitespace do not matter ("inv 001" == "INV001")."""
    k = "".join((number or "").split()).upper()
    return k or None


def lock_supplier_bills(db: Session, restaurant_id: uuid.UUID, supplier_id: uuid.UUID) -> None:
    """Serialises everything that books a supplier's bill into stock (purchase confirm, GRN with a supplier invoice number), so
    two requests cannot both decide 'not booked yet'. Transaction-scoped advisory lock."""
    db.execute(text("SELECT pg_advisory_xact_lock(hashtext(:k))"), {"k": f"supplier-bill:{restaurant_id}:{supplier_id}"})


def stock_posted_for(db: Session, restaurant_id: uuid.UUID, invoice_id: uuid.UUID) -> bool:
    from app.models.core import StockMovement
    return db.scalar(select(func.count()).select_from(StockMovement).where(
        StockMovement.restaurant_id == restaurant_id, StockMovement.ref_id == invoice_id,
        StockMovement.movement_type == MovementType.purchase)) > 0


def confirmed_duplicate(db: Session, inv: PurchaseInvoice) -> PurchaseInvoice | None:
    """Another CONFIRMED stock purchase of the same supplier with the same bill number (the same paper bill scanned twice:
    different photo, different file hash)."""
    key = bill_no_key(inv.invoice_number)
    if key is None or inv.supplier_id is None:
        return None
    rows = db.scalars(select(PurchaseInvoice).where(
        PurchaseInvoice.restaurant_id == inv.restaurant_id, PurchaseInvoice.supplier_id == inv.supplier_id,
        PurchaseInvoice.id != inv.id, PurchaseInvoice.status == PurchaseStatus.confirmed,
        PurchaseInvoice.document_type == "stock_purchase", PurchaseInvoice.invoice_number.is_not(None))).all()
    return next((r for r in rows if bill_no_key(r.invoice_number) == key), None)


def grns_for_bill(db: Session, inv: PurchaseInvoice) -> list:
    """Goods receipts whose stock already booked this bill: the GRNs linked to it (goods_receipts.purchase_invoice_id, set at
    receive time or with POST /goods-receipts/{id}/link-purchase) and the GRNs of the same supplier that recorded this
    bill's number."""
    from app.models.inventory import GoodsReceipt
    found = {g.id: g for g in db.scalars(select(GoodsReceipt).where(
        GoodsReceipt.restaurant_id == inv.restaurant_id, GoodsReceipt.purchase_invoice_id == inv.id))}
    key = bill_no_key(inv.invoice_number)
    if key is not None and inv.supplier_id is not None:
        rows = db.scalars(select(GoodsReceipt).where(
            GoodsReceipt.restaurant_id == inv.restaurant_id, GoodsReceipt.supplier_id == inv.supplier_id,
            GoodsReceipt.supplier_invoice_no.is_not(None))).all()
        for g in rows:
            if bill_no_key(g.supplier_invoice_no) == key:
                found.setdefault(g.id, g)
    return sorted(found.values(), key=lambda g: g.number)


def confirm(db: Session, p, invoice_id: uuid.UUID) -> PurchaseInvoice:
    """The only place purchase stock is posted, and only after a human has verified the draft.
    Idempotent and double-post safe: a confirmed invoice is returned as is (row lock + state guard); the same paper bill
    confirmed again under another upload is refused (409); a bill whose goods were already received on a GRN (same supplier,
    same supplier invoice number) is confirmed WITHOUT posting stock again (the GRN is the stock record)."""
    inv = load(db, p, invoice_id, lock=True)
    if inv.status == PurchaseStatus.confirmed:
        return inv  # idempotent
    if inv.status != PurchaseStatus.extracted:
        raise HTTPException(409, f"Purchase is {inv.status.value}; it must be extracted or entered first")
    if inv.document_type != "stock_purchase":
        raise HTTPException(409, "This document is not a stock purchase. Record it as an expense, or switch it back to a stock purchase")
    require_inr(inv.extracted_json)
    if not inv.lines:
        raise HTTPException(422, "Purchase has no lines")
    if not inv.supplier_id:
        raise HTTPException(422, "Choose a supplier before confirming")
    lock_supplier_bills(db, p.restaurant_id, inv.supplier_id)
    dup = confirmed_duplicate(db, inv)
    if dup is not None:
        raise HTTPException(409, f"Bill {inv.invoice_number} from this supplier was already confirmed (purchase {dup.id}); "
                                 "its stock is already added. Delete this copy or correct the bill number")
    if stock_posted_for(db, p.restaurant_id, inv.id):  # belt and braces: never two postings for one invoice
        raise HTTPException(409, "Stock for this purchase was already posted")
    grns = grns_for_bill(db, inv)
    totals: dict[uuid.UUID, tuple[Decimal, Decimal]] = {}
    for l in inv.lines:
        if l.exclude_from_stock:
            continue
        if l.needs_check:
            raise HTTPException(422, f"Line '{l.description}': check how much stock this is before confirming")
        if not l.item_id:
            raise HTTPException(422, f"Line '{l.description}' is not mapped to an inventory item")
        item = inventory.get_item(db, p, l.item_id)
        base_qty = to_base(l.quantity, l.unit, item.base_unit)
        if base_qty <= 0:
            raise HTTPException(422, f"Line '{l.description}' has no quantity")
        q, c = totals.get(item.id, (Decimal(0), Decimal(0)))
        totals[item.id] = (q + base_qty, c + l.line_total)
        if not item.supplier_manual and item.supplier_id != inv.supplier_id:
            item.supplier_id = inv.supplier_id  # "usual supplier" follows the latest confirmed purchase unless the owner chose one
    if not totals:
        raise HTTPException(422, "Every line is marked 'not stock'. Nothing to add")
    for g in grns:  # matched by bill number: record the link (PO <-> GRN <-> purchase bill) for the next reader
        if g.purchase_invoice_id is None:
            g.purchase_invoice_id = inv.id
    if not grns:
        for item_id, (qty, cost) in totals.items():
            inventory.post(db, p.restaurant_id, item_id, MovementType.purchase, qty, ref_id=inv.id,
                           unit_cost=(cost / qty).quantize(Decimal("0.0001")), user_id=p.user_id,
                           detail={"invoice_number": inv.invoice_number})
    inv.status, inv.confirmed_by, inv.confirmed_at = PurchaseStatus.confirmed, p.user_id, datetime.now().astimezone()
    detail = {"items": len(totals), "stock_posted": not grns}
    if grns:
        detail["already_received_on"] = sorted(g.number for g in grns)
    audit.record(db, p, "purchase.confirm", "purchase_invoice", inv.id, detail)
    if not grns:
        alerts.evaluate(db, p.restaurant_id, list(totals))
    db.commit()
    return inv
