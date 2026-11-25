import re
import uuid
from datetime import date, datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.deps import P, Principal, current_principal, require_feature, require_perm
from app.core.db import get_db
from app.models.core import Restaurant, User
from app.services import audit, insights, mis, outlets, report_csv, report_pdf, reports as r, zreport as z

router = APIRouter(prefix="/reports", tags=["reports"])
reports_module = Depends(require_feature("reports"))  # Manage > Features: Reports (the X / Z report = end of day is not part of it)


def report_ctx(request: Request, outlet_id: uuid.UUID | None = None, p: Principal = Depends(current_principal),
               db: Session = Depends(get_db)) -> r.Ctx:
    """Outlet scope of a report: `outlet_id` query param (403 if not accessible), else the outlet chosen with X-Outlet-Id, else
    every outlet the user can access (an outlet-restricted custom role only ever sees its own outlets). The permission guard
    (reports.view) is declared on each route, not here, so the route-role snapshot sees it."""
    return r.Ctx.for_principal(db, p, outlet_id, chosen=bool(request.headers.get("x-outlet-id")))


@router.get("/daily-sales", dependencies=[reports_module])
def daily_sales(from_date: date, to_date: date, c: r.Ctx = Depends(report_ctx), _: Principal = Depends(require_perm(P.REPORTS_VIEW))):
    return r.to_json(r.daily_sales(c, from_date, to_date))


@router.get("/item-sales", dependencies=[reports_module])
def item_sales(from_date: date, to_date: date, limit: int = 20, c: r.Ctx = Depends(report_ctx), _: Principal = Depends(require_perm(P.REPORTS_VIEW))):
    return r.to_json(r.item_sales(c, from_date, to_date, limit))


@router.get("/order-summary", dependencies=[reports_module])
def order_summary(from_date: date, to_date: date, c: r.Ctx = Depends(report_ctx), _: Principal = Depends(require_perm(P.REPORTS_VIEW))):
    return r.to_json(r.order_summary(c, from_date, to_date))


@router.get("/purchases", dependencies=[reports_module])
def purchases(from_date: date, to_date: date, c: r.Ctx = Depends(report_ctx), _: Principal = Depends(require_perm(P.REPORTS_VIEW))):
    return r.to_json(r.purchase_summary(c, from_date, to_date))


@router.get("/profitability", dependencies=[reports_module])
def profitability(from_date: date, to_date: date, c: r.Ctx = Depends(report_ctx), _: Principal = Depends(require_perm(P.REPORTS_VIEW))):
    return r.to_json(r.profitability(c, from_date, to_date))


@router.get("/sales-by-category", dependencies=[reports_module])
def sales_by_category(from_date: date, to_date: date, c: r.Ctx = Depends(report_ctx), _: Principal = Depends(require_perm(P.REPORTS_VIEW))):
    return r.to_json(r.category_sales(c, from_date, to_date))


# ---- insight reports (JSON for the Reports page; the same data the PDFs and the AI tools use).
# Dates: `from` / `to` (YYYY-MM-DD, restaurant local time, inclusive); `from_date` / `to_date` are accepted too.
def date_range(from_: date | None = Query(None, alias="from"), to: date | None = Query(None),
               from_date: date | None = None, to_date: date | None = None) -> tuple[date, date]:
    a, b = from_ or from_date, to or to_date
    if a is None or b is None:
        raise HTTPException(422, "from and to are required (YYYY-MM-DD)")
    return a, b


@router.get("/leakage", dependencies=[reports_module])
def leakage(rng: tuple[date, date] = Depends(date_range), c: r.Ctx = Depends(report_ctx), _: Principal = Depends(require_perm(P.REPORTS_VIEW))):
    return r.to_json(insights.leakage(c, *rng))


@router.get("/staff-sales", dependencies=[reports_module])
def staff_sales(rng: tuple[date, date] = Depends(date_range), c: r.Ctx = Depends(report_ctx), _: Principal = Depends(require_perm(P.REPORTS_VIEW))):
    return r.to_json(insights.staff_sales(c, *rng))


@router.get("/food-cost", dependencies=[reports_module])
def food_cost(rng: tuple[date, date] = Depends(date_range), limit: int = Query(50, ge=1, le=500), c: r.Ctx = Depends(report_ctx),
              _: Principal = Depends(require_perm(P.REPORTS_VIEW))):
    return r.to_json(insights.dish_food_cost(c, *rng, limit))


@router.get("/profit-and-loss", dependencies=[reports_module])
def profit_and_loss(rng: tuple[date, date] = Depends(date_range), c: r.Ctx = Depends(report_ctx), _: Principal = Depends(require_perm(P.REPORTS_VIEW))):
    return r.to_json(insights.profit_and_loss(c, *rng))


@router.get("/customers", dependencies=[reports_module])
def customers(rng: tuple[date, date] = Depends(date_range), c: r.Ctx = Depends(report_ctx), _: Principal = Depends(require_perm(P.REPORTS_VIEW))):
    return r.to_json(insights.customer_insights(c, *rng))


# ---- MIS reports (docs/REPORTS.md). All outlet-scoped like the reports above.
@router.get("/gst-summary", dependencies=[reports_module])
def gst_summary(rng: tuple[date, date] = Depends(date_range), c: r.Ctx = Depends(report_ctx), _: Principal = Depends(require_perm(P.REPORTS_VIEW))):
    return r.to_json(mis.gst_summary(c, *rng))


@router.get("/payments", dependencies=[reports_module])
def payments(rng: tuple[date, date] = Depends(date_range), c: r.Ctx = Depends(report_ctx), _: Principal = Depends(require_perm(P.REPORTS_VIEW))):
    """Payments by method and by cashier; voided and unpaid are reported apart from sales."""
    return r.to_json(mis.payments_report(c, *rng))


@router.get("/sales-summary", dependencies=[reports_module])
def sales_summary(rng: tuple[date, date] = Depends(date_range), group_by: Literal["day", "month"] = "day", c: r.Ctx = Depends(report_ctx), _: Principal = Depends(require_perm(P.REPORTS_VIEW))):
    return r.to_json(mis.period_sales(c, *rng, group_by))


@router.get("/top-items", dependencies=[reports_module])
def top_items(rng: tuple[date, date] = Depends(date_range), direction: Literal["top", "bottom"] = "top",
              by: Literal["revenue", "quantity"] = "revenue", limit: int = Query(20, ge=1, le=200), offset: int = Query(0, ge=0),
              c: r.Ctx = Depends(report_ctx), _: Principal = Depends(require_perm(P.REPORTS_VIEW))):
    return r.to_json(mis.item_ranking(c, *rng, direction, by, limit, offset))


@router.get("/outlet-comparison", dependencies=[reports_module])
def outlet_comparison(rng: tuple[date, date] = Depends(date_range), c: r.Ctx = Depends(report_ctx), _: Principal = Depends(require_perm(P.REPORTS_VIEW))):
    return r.to_json(mis.outlet_comparison(c, *rng))


@router.get("/csv", dependencies=[reports_module])
def report_csv_download(kind: Literal[tuple(report_csv.KINDS)], rng: tuple[date, date] = Depends(date_range),  # type: ignore[valid-type]
                        p: Principal = Depends(require_perm(P.REPORTS_VIEW)), c: r.Ctx = Depends(report_ctx), db: Session = Depends(get_db)):
    """CSV of a report (UTF-8 with BOM, spreadsheet-formula-safe cells). Audited like the PDF."""
    c.window(*rng)
    body = report_csv.build(c, kind, *rng)
    audit.record(db, p, "report.csv", "report", None, {"kind": kind, "from": rng[0].isoformat(), "to": rng[1].isoformat()})
    db.commit()
    name = f"{kind}_{rng[0].isoformat()}_{rng[1].isoformat()}.csv"
    return Response(body, media_type="text/csv; charset=utf-8", headers={"Content-Disposition": f'attachment; filename="{name}"'})


# ---- A4 PDF of any report kind. Rendered on download from current data; nothing is stored.
ReportKind = Literal[tuple(report_pdf.KINDS)]  # type: ignore[valid-type]  # enum of kinds in the OpenAPI schema


def pdf_filename(name: str, kind: str, d_from: date, d_to: date) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "restaurant"
    return f"{slug}_{kind}_{d_from.isoformat()}_{d_to.isoformat()}.pdf"


@router.get("/pdf", dependencies=[reports_module])
def report_pdf_download(kind: ReportKind, rng: tuple[date, date] = Depends(date_range), p: Principal = Depends(require_perm(P.REPORTS_VIEW)),
                        c: r.Ctx = Depends(report_ctx), db: Session = Depends(get_db)):
    c.window(*rng)  # 422 for to < from or a range over 366 days, before any work
    restaurant = db.get(Restaurant, p.restaurant_id)
    pdf = report_pdf.render(kind, report_pdf.collect(c, kind, *rng), report_pdf.restaurant_info(restaurant), rng,
                            datetime.now(timezone.utc))
    audit.record(db, p, "report.pdf", "report", None, {"kind": kind, "from": rng[0].isoformat(), "to": rng[1].isoformat()})
    db.commit()
    name = pdf_filename(restaurant.name, kind, *rng)
    return Response(pdf, media_type="application/pdf", headers={"Content-Disposition": f'attachment; filename="{name}"'})


# ---- end of day: X (mid-day, not stored) and Z (closes the period, stored immutably) ----
class ZCloseIn(BaseModel):
    idempotency_key: uuid.UUID


def _pdf(pdf: bytes, name: str) -> Response:
    return Response(pdf, media_type="application/pdf", headers={"Content-Disposition": f'inline; filename="{name}"'})


def _user_name(db: Session, p: Principal) -> str | None:
    u = db.get(User, p.user_id)
    return u.full_name if u else None


@router.get("/x-report")
def x_report(outlet_id: uuid.UUID | None = None, p: Principal = Depends(require_perm(P.REPORTS_VIEW)), db: Session = Depends(get_db)):
    """Current period of an outlet (the request's, or `outlet_id`) up to now: since its last Z, or since its first activity when it
    never closed one. This is exactly what the next Z close will save; `close_period` ({from, from_local, days, first_close}) says
    from when and over how many days. Not stored."""
    return r.to_json(z.x_report(db, p.restaurant_id, outlets.scope(p, outlet_id, all_by_default=False)[0]))


@router.get("/x-report/slip.pdf")
def x_report_slip(outlet_id: uuid.UUID | None = None, p: Principal = Depends(require_perm(P.REPORTS_VIEW)), db: Session = Depends(get_db)):
    pdf = z.render_pdf(z.x_report(db, p.restaurant_id, outlets.scope(p, outlet_id, all_by_default=False)[0]), _user_name(db, p))
    audit.record(db, p, "xreport.print", "x_report", None)
    db.commit()
    return _pdf(pdf, "X-REPORT.pdf")


@router.post("/z-report", status_code=201)
def close_day(data: ZCloseIn, response: Response, p: Principal = Depends(require_perm(P.REPORTS_CLOSE_DAY)), db: Session = Depends(get_db)):
    """Closes the trading period and stores the snapshot. 201 on creation, 200 when the key was already used
    (the same stored report is returned)."""
    zr, created = z.close_day(db, p, data.idempotency_key)
    if not created:
        response.status_code = 200
    return z.stored_out(zr)


@router.get("/z-reports")
def z_reports(limit: int = Query(30, ge=1, le=100), cursor: str | None = None, outlet_id: uuid.UUID | None = None,
              p: Principal = Depends(require_perm(P.REPORTS_VIEW)), db: Session = Depends(get_db)):
    """Z reports of the request's outlet (X-Outlet-Id, default outlet), or of `outlet_id`. Z numbers are per outlet, so the
    list (and its cursor) is always one outlet's sequence."""
    return z.list_reports(db, p.restaurant_id, limit, cursor, outlets.scope(p, outlet_id, all_by_default=False))


@router.get("/z-reports/{report_id}")
def z_report(report_id: uuid.UUID, p: Principal = Depends(require_perm(P.REPORTS_VIEW)), db: Session = Depends(get_db)):
    return z.stored_out(z.get_report(db, p.restaurant_id, report_id, p))


@router.get("/z-reports/{report_id}/slip.pdf")
def z_report_slip(report_id: uuid.UUID, p: Principal = Depends(require_perm(P.REPORTS_VIEW)), db: Session = Depends(get_db)):
    zr = z.get_report(db, p.restaurant_id, report_id, p)
    prior = z.print_count(db, p.restaurant_id, zr.id)
    pdf = z.render_pdf(z.stored_out(zr), _user_name(db, p), reprint=prior)
    audit.record(db, p, "zreport.print", "z_report", zr.id, {"number": zr.number, "reprint": prior > 0})
    db.commit()
    return _pdf(pdf, f"{z.number_label(zr.number)}.pdf")
