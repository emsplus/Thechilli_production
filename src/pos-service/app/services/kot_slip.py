"""80 mm kitchen order ticket (no prices). Built from the KOT's immutable payload snapshot."""
from zoneinfo import ZoneInfo

from sqlalchemy import select

from app.models.core import DiningTable, Kot, KotStatus, Order, Restaurant, User
from app.services import thermal as T
from app.services.receipt import type_label
from app.services.thermal import Slip, safe


def is_addon(db, kot: Kot) -> bool:
    """True when the order already had an earlier KOT (this one carries only items added later)."""
    return db.scalar(select(Kot.id).where(Kot.order_id == kot.order_id, Kot.number < kot.number).limit(1)) is not None


def render_kot_slip(db, kot: Kot, reprint: bool = False) -> bytes:
    rest = db.get(Restaurant, kot.restaurant_id)
    order = db.get(Order, kot.order_id)
    table = db.get(DiningTable, order.table_id) if order and order.table_id else None
    waiter = db.get(User, order.created_by) if order else None
    when = kot.created_at.astimezone(ZoneInfo(rest.timezone))
    s = Slip(f"KOT {kot.number}")
    s.line(f"KOT #{kot.number}", 22, True, extra=1)
    s.line(rest.name, 10, True)
    if kot.status == KotStatus.cancelled:
        s.space(2)
        s.box("CANCELLED", 15)
    if reprint:
        s.line("** REPRINT **", 8.5, True)
    if is_addon(db, kot):
        s.line("*** ADD-ON TO EARLIER ORDER ***", 9, True)
    s.rule(heavy=True)
    otype = type_label(order.order_type.value) if order else None
    if table:
        s.pair(f"Table: {table.label}", otype or "", size=10, bold=True)
    elif otype:
        s.pair(f"Type: {otype}", "", size=10, bold=True)
    s.pair(f"{when.strftime('%d/%m/%Y')}  {when.strftime('%I:%M %p').lstrip('0')}",
           f"Order {str(kot.order_id)[:8].upper()}", size=8)
    if waiter:
        s.line(f"By {waiter.full_name}", 7.5, align="l", grey=True)
    if order and order.token_number is not None:
        s.line(f"Token {order.token_number}", 12, True, align="l")
    if order and order.note:
        for part in T.wrap(f"Note: {order.note}", T.BOLD, 9, T.INNER):
            s.text(part, 9, True)
            s.advance(9)
    s.rule()
    s.text("ITEM", 8.5, True)
    s.text("QTY", 8.5, True, "r")
    s.advance(8.5)
    s.rule(dashed=True, pad=1.5)
    total = 0
    for i, ln in enumerate(kot.payload, 1):
        qty = int(ln.get("qty", 1))
        total += 1
        names = T.wrap(f"{i}. {ln.get('item', '')}", T.BOLD, 10, T.INNER - 30)
        s.text(names[0], 10, True)
        s.text(str(qty), 12, True, "r")
        s.advance(12)
        for extra in names[1:]:
            s.text(extra, 10, True)
            s.advance(10)
        for sub in [f"> {m}" for m in ln.get("modifiers") or []] + [
                f"* {c.get('qty', 1)} x {c.get('item', '')}" for c in ln.get("components") or []]:
            for part in T.wrap(sub, T.REG, 9, T.INNER - 14):  # modifiers / combo contents (docs/MODIFIERS_OFFERS.md)
                s.text(part, 9, False, "l", x=T.MARGIN + 10)
                s.advance(9)
        if ln.get("note"):
            for part in T.wrap(f"- {ln['note']}", T.REG, 8, T.INNER - 14):
                s.text(part, 8, False, "l", x=T.MARGIN + 10)
                s.advance(8)
        s.space(2.5)
    s.rule()
    s.pair(f"Total: {total} item{'s' if total != 1 else ''}", "", size=9.5, bold=True)
    s.cut_line()
    return s.render()
