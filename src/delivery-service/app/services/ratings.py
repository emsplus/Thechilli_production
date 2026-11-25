"""Rating after delivery (asked on WhatsApp). Low ratings alert the managers and ask for a few words."""
import re

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Conversation, DeliveryOrder, OrderRating
from app.services import notify

_WORDS = {"great": 5, "good": 4, "okay": 3, "ok": 3, "bad": 1, "poor": 1, "बढ़िया": 5, "अच्छा": 4, "ठीक": 3, "खराब": 1}


def parse_rating(text: str) -> int | None:
    """"5", "4 stars", stars, or great/okay/bad (Hindi words are accepted as input). Anything longer than a short answer is not a rating."""
    t = text.strip().lower()
    if not t or len(t) > 14:
        return None
    if t.count("⭐") in range(1, 6) and not re.search(r"[a-z0-9]", t):
        return t.count("⭐")
    m = re.fullmatch(r"([1-5])(?:\s*(?:/\s*5|stars?|star))?", t)
    if m:
        return int(m.group(1))
    return _WORDS.get(t)


def ask(db: Session, order: DeliveryOrder) -> None:
    """Called when an order is delivered: queue the rating question and remember what the next reply answers."""
    convo = db.scalar(select(Conversation).where(Conversation.restaurant_id == order.restaurant_id,
                                                 Conversation.wa_number == order.wa_number))
    if convo is None:
        convo = Conversation(restaurant_id=order.restaurant_id, wa_number=order.wa_number, context={})
        db.add(convo)
    convo.context = {**(convo.context or {}), "awaiting": "rating", "rating_order": str(order.id)}
    notify.enqueue_message(db, order.restaurant_id, order.wa_number, "rating_request", order, code=order.order_code)


def _alert(db, order, reason):
    from app.services import orders as svc  # lazy: orders imports this module
    svc.alert_managers(db, order, reason)


def save(db: Session, restaurant_id: str, order_id, rating: int) -> DeliveryOrder | None:
    order = db.scalar(select(DeliveryOrder).where(DeliveryOrder.id == order_id,
                                                  DeliveryOrder.restaurant_id == restaurant_id))
    if order is None or db.get(OrderRating, (restaurant_id, order.id)):
        return None
    db.add(OrderRating(restaurant_id=restaurant_id, order_id=order.id, rating=rating))
    if rating <= 3:
        _alert(db, order, f"low rating {rating}/5")
    return order


def add_feedback(db: Session, restaurant_id: str, order_id, feedback: str) -> None:
    row = db.get(OrderRating, (restaurant_id, order_id))
    if row:
        row.feedback = feedback[:500]
        order = db.get(DeliveryOrder, order_id)
        if order:
            _alert(db, order, f"feedback: {feedback[:150]}")
