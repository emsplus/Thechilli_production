from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Order, Payout
from app.services.audit import audit


def reconcile(s: Session, payout: Payout) -> Payout:
    """Match each line to an order (same tenant+provider) and compare gross to order total; check line sums against
    the payout header. Idempotent - safe to re-run after late orders/mappings arrive."""
    issues = []
    for ln in payout.lines:
        o = s.scalar(select(Order).where(Order.tenant_id == payout.tenant_id, Order.provider == payout.provider,
                                         Order.external_order_id == ln.external_order_id))
        if o is None:
            ln.order_id, ln.match_status = None, "order_not_found"
            issues.append({"type": "order_not_found", "external_order_id": ln.external_order_id})
        elif o.total_minor != ln.gross_minor or o.currency != payout.currency:
            ln.order_id, ln.match_status = o.id, "amount_mismatch"
            issues.append({"type": "amount_mismatch", "external_order_id": ln.external_order_id,
                           "order_total_minor": o.total_minor, "payout_gross_minor": ln.gross_minor})
        else:
            ln.order_id, ln.match_status = o.id, "matched"
    for field in ("gross_minor", "commission_minor", "net_minor"):
        total = sum(getattr(l, field) for l in payout.lines)
        if total != getattr(payout, field):
            issues.append({"type": f"{field}_sum_mismatch", "lines_total": total, "header": getattr(payout, field)})
    if payout.gross_minor - payout.commission_minor - payout.fees_minor != payout.net_minor:
        issues.append({"type": "header_arithmetic", "detail": "gross - commission - fees != net"})
    for l in payout.lines:
        if l.gross_minor - l.commission_minor != l.net_minor:
            issues.append({"type": "line_arithmetic", "external_order_id": l.external_order_id})
    payout.discrepancies = issues
    payout.status = "discrepancy" if issues else "reconciled"
    audit(s, actor="system", action="payout.reconciled", tenant_id=payout.tenant_id, entity_type="payout",
          entity_id=payout.id, status=payout.status, issue_count=len(issues))
    return payout
