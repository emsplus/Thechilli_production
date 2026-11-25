"""Restaurant printing: printers, print hubs, the job queue the hub pulls from, reprints (docs/print-hub-contract.md)."""
import base64
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from sqlalchemy import select
from starlette.concurrency import run_in_threadpool
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.deps import bearer, P, Principal, require_perm
from app.core.db import get_db
from app.core.tenancy import bind_tenant
from app.models.core import PrintHub, PrintJob, Printer
from app.schemas.printing import (
    HeartbeatIn, HeartbeatOut, HubJobsOut, HubOut, JobOut, JobsOut, PairIn, PairingOut, PairOut, PrinterIn,
    PrinterBrief, PrinterOut, PrinterPatch, ReprintIn, ResultIn, TestIn,
)
from app.services import audit, outlets, printing as svc

router = APIRouter(tags=["printing"])


# ---------------------------------------------------------------------------------------------- helpers
def _printer_out(pr: Printer, status: dict[str, str]) -> PrinterOut:
    out = PrinterOut.model_validate(pr)
    out.kot_category_ids = list(pr.kot_category_ids or [])
    out.status = status.get(str(pr.id), "unknown")  # type: ignore[assignment]
    return out


def _job_outs(db: Session, jobs: list[PrintJob]) -> list[JobOut]:
    names = dict(db.execute(select(Printer.id, Printer.name).where(Printer.id.in_({j.printer_id for j in jobs}))).all()) if jobs else {}
    return [JobOut(id=j.id, printer_id=j.printer_id, printer_name=names.get(j.printer_id), kind=j.kind, ref_id=j.ref_id,
                   copy_no=j.copy_no, reprint_no=j.reprint_no, status=j.status, attempts=j.attempts,
                   last_error=j.last_error, created_by=j.created_by, created_at=j.created_at, sent_at=j.sent_at,
                   printed_at=j.printed_at) for j in jobs]


async def current_hub(creds=Depends(bearer)):
    if creds is None:
        raise HTTPException(401, "Hub token required")
    return await run_in_threadpool(svc.authenticate_hub, creds.credentials)  # cached; a miss does two short queries


# ---------------------------------------------------------------------------------------------- printers (owner / manager)
@router.get("/print/printers", response_model=list[PrinterOut])
def list_printers(outlet_id: uuid.UUID | None = None, p: Principal = Depends(require_perm(P.PRINTING_MANAGE)),
                  db: Session = Depends(get_db)):
    status = svc.printer_statuses(db, p.restaurant_id)
    rows = db.scalars(select(Printer).where(Printer.restaurant_id == p.restaurant_id,
                                            Printer.outlet_id.in_(outlets.scope(p, outlet_id, all_by_default=False)))
                      .order_by(Printer.created_at, Printer.name))
    return [_printer_out(r, status) for r in rows]


@router.get("/print/printers/available", response_model=list[PrinterBrief])
def available_printers(p: Principal = Depends(require_perm(P.PRINTING_USE)), db: Session = Depends(get_db)):
    """Which printers can the till print to? Names and the two auto-print switches only (no IP / queue details), for the roles
    that take orders, so Chilli Agent knows whether to offer "Print" and whether to send the kitchen slip when an order is placed."""
    rows = db.scalars(select(Printer).where(Printer.restaurant_id == p.restaurant_id, Printer.is_active,
                                            Printer.outlet_id == p.outlet_id).order_by(Printer.created_at, Printer.name))
    return [{"id": r.id, "name": r.name, "role": r.role, "auto_bill": r.auto_bill, "auto_kot": r.auto_kot} for r in rows]


@router.post("/print/printers", response_model=PrinterOut, status_code=201)
def create_printer(data: PrinterIn, p: Principal = Depends(require_perm(P.PRINTING_MANAGE)), db: Session = Depends(get_db)):
    d = data.model_dump()
    oid = outlets.outlet_of(db, p)
    svc.validate_printer(db, p.restaurant_id, d, oid)
    pr = Printer(restaurant_id=p.restaurant_id, outlet_id=oid, **d)
    db.add(pr)
    try:
        db.flush()
    except IntegrityError:  # concurrent duplicate name
        db.rollback()
        raise HTTPException(409, f"A printer named '{d['name']}' already exists")
    audit.record(db, p, "printer.create", "printer", pr.id, {"name": pr.name, "connection": pr.connection})
    db.commit()
    return _printer_out(pr, {})


@router.patch("/print/printers/{printer_id}", response_model=PrinterOut)
def update_printer(printer_id: uuid.UUID, data: PrinterPatch, p: Principal = Depends(require_perm(P.PRINTING_MANAGE)),
                   db: Session = Depends(get_db)):
    pr = svc.get_printer(db, p, printer_id)
    changes = data.model_dump(exclude_unset=True)
    for k in ("name", "role", "connection", "port", "columns", "codepage", "copies", "cut", "is_active", "auto_bill",
              "auto_kot", "kot_category_ids"):
        if k in changes and changes[k] is None:
            raise HTTPException(422, f"{k} cannot be null")
    for k in ("host", "system_name"):
        if k in changes and isinstance(changes[k], str):
            changes[k] = changes[k].strip() or None
    merged = {c.name: getattr(pr, c.name) for c in Printer.__table__.columns}
    merged.update(changes)
    PrinterIn.model_validate({k: v for k, v in merged.items() if k in PrinterIn.model_fields})  # same rules as create
    svc.validate_printer(db, p.restaurant_id, merged, pr.outlet_id)
    for k, v in changes.items():
        setattr(pr, k, v)
    audit.record(db, p, "printer.update", "printer", pr.id, {"fields": sorted(changes)})
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "A printer with that name already exists")
    return _printer_out(pr, svc.printer_statuses(db, p.restaurant_id))


@router.delete("/print/printers/{printer_id}", status_code=204)
def delete_printer(printer_id: uuid.UUID, p: Principal = Depends(require_perm(P.PRINTING_MANAGE)), db: Session = Depends(get_db)):
    pr = svc.get_printer(db, p, printer_id)
    audit.record(db, p, "printer.delete", "printer", pr.id, {"name": pr.name})
    db.delete(pr)  # its jobs go with it (ON DELETE CASCADE)
    db.commit()
    return Response(status_code=204)


@router.post("/print/printers/{printer_id}/test", response_model=JobsOut, status_code=201)
def test_printer(printer_id: uuid.UUID, data: TestIn | None = None, p: Principal = Depends(require_perm(P.PRINTING_MANAGE)), db: Session = Depends(get_db)):
    pr = svc.get_printer(db, p, printer_id)
    return JobsOut(jobs=_job_outs(db, svc.send_test_page(db, p, pr, data.codepage if data else None)))


# ---------------------------------------------------------------------------------------------- hubs (owner / manager)
@router.post("/print/hubs/pairing", response_model=PairingOut, status_code=201)
def new_pairing(p: Principal = Depends(require_perm(P.PRINTING_MANAGE)), db: Session = Depends(get_db)):
    code, row = svc.create_pairing(db, p)
    return PairingOut(code=code, expires_at=row.expires_at)


@router.get("/print/hubs", response_model=list[HubOut])
def list_hubs(p: Principal = Depends(require_perm(P.PRINTING_MANAGE)), db: Session = Depends(get_db)):
    rows = db.scalars(select(PrintHub).where(PrintHub.restaurant_id == p.restaurant_id, PrintHub.revoked_at.is_(None))
                      .order_by(PrintHub.created_at))
    return [HubOut(id=h.id, name=h.name, last_seen_at=h.last_seen_at, version=h.version, os=h.os,
                   system_printers=list(h.system_printers or []), printer_status=dict(h.printer_status or {}),
                   created_at=h.created_at, online=svc.is_online(h)) for h in rows]


@router.delete("/print/hubs/{hub_id}", status_code=204)
def revoke_hub(hub_id: uuid.UUID, p: Principal = Depends(require_perm(P.PRINTING_MANAGE)), db: Session = Depends(get_db)):
    svc.revoke_hub(db, p, hub_id)
    return Response(status_code=204)


# ---------------------------------------------------------------------------------------------- jobs / reprints (POS roles)
@router.get("/print/jobs", response_model=list[JobOut])
def list_jobs(ref_id: uuid.UUID | None = None, limit: int = Query(50, ge=1, le=200),
              p: Principal = Depends(require_perm(P.PRINTING_USE)), db: Session = Depends(get_db)):
    q = select(PrintJob).where(PrintJob.restaurant_id == p.restaurant_id)
    if ref_id:
        q = q.where(PrintJob.ref_id == ref_id)
    return _job_outs(db, list(db.scalars(q.order_by(PrintJob.created_at.desc(), PrintJob.id).limit(limit))))


@router.post("/bills/{bill_id}/print", response_model=JobsOut, status_code=201)
def print_bill(bill_id: uuid.UUID, data: ReprintIn | None = None, p: Principal = Depends(require_perm(P.PRINTING_USE)),
               db: Session = Depends(get_db)):
    return JobsOut(jobs=_job_outs(db, svc.reprint_bill(db, p, bill_id, data.printer_id if data else None)))


@router.post("/kot/{kot_id}/print", response_model=JobsOut, status_code=201)
def print_kot(kot_id: uuid.UUID, data: ReprintIn | None = None, p: Principal = Depends(require_perm(P.PRINTING_USE)),
              db: Session = Depends(get_db)):
    return JobsOut(jobs=_job_outs(db, svc.reprint_kot(db, p, kot_id, data.printer_id if data else None)))


# ---------------------------------------------------------------------------------------------- hub (bearer hub token)
@router.post("/print/hub/pair", response_model=PairOut)
def hub_pair(data: PairIn, request: Request, db: Session = Depends(get_db)):
    ip = request.client.host if request.client else "unknown"  # X-Forwarded-For is not trusted (see receipt_links)
    token, hub = svc.pair_hub(db, data.code, data.name, data.os, data.version, ip)
    return PairOut(token=token, hub_id=hub.id)


@router.post("/print/hub/heartbeat", response_model=HeartbeatOut)
def hub_heartbeat(data: HeartbeatIn, hub=Depends(current_hub), db: Session = Depends(get_db)):
    bind_tenant(db, hub.restaurant_id)
    return HeartbeatOut(printers=svc.heartbeat(db, hub, data))


@router.get("/print/hub/jobs", response_model=HubJobsOut)
async def hub_jobs(wait: float = Query(25, ge=0, le=3600), hub=Depends(current_hub)):
    """Long poll. Async on purpose: while it waits it holds no thread and no DB connection (poll_jobs_async); every check is its
    own short transaction and takes no get_db session."""
    jobs = await svc.poll_jobs_async(hub, wait)
    return {"jobs": [{"id": j["id"], "printer": j["printer"], "attempts": j["attempts"],
                      "payload_b64": base64.b64encode(j["payload"]).decode()} for j in jobs]}


@router.post("/print/hub/jobs/{job_id}/result", status_code=204)
def hub_result(job_id: uuid.UUID, data: ResultIn, hub=Depends(current_hub), db: Session = Depends(get_db)):
    bind_tenant(db, hub.restaurant_id)
    svc.job_result(db, hub, job_id, data.ok, data.error)
    return Response(status_code=204)
