"""WhatsApp conversation engine (fresh implementation; behaviour modelled on Bolt's food-delivery chat, no code shared).

Guided flow: address -> name -> location pin (radius check) -> payment choice -> menu link carrying those details. Also:
status/track, menu, cancel, rating after delivery, voice-note acknowledgement, opt-out (STOP/START). Replies are free text
(sent inside the 24 h window the customer just opened). Owner decision 2026-10-31: replies are ENGLISH ONLY. The Hindi strings
stay in the catalogue and are used only when DELIVERY_ENABLE_LANGUAGES=1; Hindi INPUT words (रद्द, स्टेटस, बंद...) are always
understood.

The conversation's `context` JSON holds: awaiting, lang, details {name,address,lat,lng,pay}, rating_order.
The details are NOT put in a URL: the menu page fetches them with its signed link (GET /public/menu/{token} -> prefill).
"""
import re

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models import Conversation, DeliveryOrder, InboundMessage, Restaurant
from app.providers.base import InboundMessageEvent
from app.services import consent, geo, notify, ratings
from app.services import orders as svc

DEVANAGARI = re.compile(r"[ऀ-ॿ]")
NAME_RE = re.compile(r"[A-Za-zऀ-ॿ][A-Za-zऀ-ॿ .'\-]{1,59}")
# A tapped quick-reply comes back as text; it must never be saved as a name or address.
BUTTON_WORDS = ("menu", "cash on delivery", "pay online", "new address", "yes", "no", "skip", "cancel", "status")

M = {
    "greet_addr": {"en": "Welcome to {brand}! Please send your full delivery address (house/flat no., street, landmark, area).",
                   "hi": "{brand} में आपका स्वागत है! कृपया अपना पूरा डिलीवरी पता भेजें (मकान/फ़्लैट नं., गली, लैंडमार्क, इलाका)."},
    "saved": {"en": "Deliver to {address}? Reply YES, or send a new address.",
              "hi": "क्या {address} पर डिलीवरी करें? YES लिखें, या नया पता भेजें."},
    "bad_addr": {"en": "That does not look like a full address. Please send house/flat no., street, landmark and area.",
                 "hi": "यह पूरा पता नहीं लग रहा. कृपया मकान/फ़्लैट नं., गली, लैंडमार्क और इलाका भेजें."},
    "ask_name": {"en": "Thanks! What name should the delivery person ask for?",
                 "hi": "धन्यवाद! डिलीवरी वाले को किस नाम से पूछना है?"},
    "bad_name": {"en": "Please send a name (letters only).", "hi": "कृपया नाम भेजें (सिर्फ़ अक्षर)."},
    "ask_pin": {"en": "Please share your location: tap the clip icon, choose Location, then Send your current location. "
                      "You can also paste a Google Maps link.",
                "hi": "कृपया अपनी लोकेशन भेजें: क्लिप आइकन दबाएँ, Location चुनें, फिर मौजूदा लोकेशन भेजें. Google Maps लिंक भी चलेगा."},
    "ask_pin_opt": {"en": "Share your location pin so the rider finds you faster (or reply SKIP).",
                    "hi": "राइडर को जल्दी ढूँढने के लिए लोकेशन भेजें (या SKIP लिखें)."},
    "pin_ok": {"en": "Location received ({km} km from us).", "hi": "लोकेशन मिल गई ({km} किमी दूर)."},
    "pin_saved": {"en": "Location received. It helps the rider find you.", "hi": "लोकेशन मिल गई. इससे राइडर आपको ढूँढ लेगा."},
    "outside": {"en": "Sorry, we deliver up to {radius} km and you are about {km} km away. Share a location closer to us, "
                      "or send CANCEL to stop.",
                "hi": "माफ़ कीजिए, हम {radius} किमी तक डिलीवरी करते हैं और आप लगभग {km} किमी दूर हैं. हमारे पास की लोकेशन भेजें, "
                      "या रोकने के लिए CANCEL लिखें."},
    "bad_pin": {"en": "I could not read that location. Please share a location pin or a Google Maps link.",
                "hi": "वह लोकेशन पढ़ नहीं पाया. कृपया लोकेशन पिन या Google Maps लिंक भेजें."},
    "ask_pay": {"en": "How would you like to pay? Reply 1 for cash on delivery, or 2 to pay online (UPI).",
                "hi": "भुगतान कैसे करेंगे? 1 लिखें कैश ऑन डिलीवरी के लिए, या 2 ऑनलाइन (UPI) के लिए."},
    "pay_bad": {"en": "Reply 1 for cash on delivery, or 2 to pay online.", "hi": "1 (कैश ऑन डिलीवरी) या 2 (ऑनलाइन) लिखें."},
    "no_online": {"en": "Online payment is not available right now, so this will be cash on delivery.",
                  "hi": "ऑनलाइन भुगतान अभी उपलब्ध नहीं है, इसलिए यह कैश ऑन डिलीवरी रहेगा."},
    "no_cod": {"en": "Cash on delivery is not available right now, so this will be paid online.",
               "hi": "कैश ऑन डिलीवरी अभी उपलब्ध नहीं है, इसलिए भुगतान ऑनलाइन होगा."},
    "pay_cod": {"en": "Cash on delivery.", "hi": "कैश ऑन डिलीवरी."},
    "pay_online": {"en": "Online payment: pay by UPI{qr}. Your order is confirmed as paid only after the restaurant verifies the "
                         "payment; a screenshot alone is not proof.",
                   "hi": "ऑनलाइन भुगतान: UPI से भुगतान करें{qr}. रेस्टोरेंट के पुष्टि करने के बाद ही ऑर्डर पेड माना जाएगा; "
                         "सिर्फ़ स्क्रीनशॉट प्रमाण नहीं है."},
    "ready": {"en": "All set, {name}. Pick your food here: {link}", "hi": "सब तैयार है, {name}. यहाँ से खाना चुनें: {link}"},
    "cancelled": {"en": "Okay, cleared. Send Hi whenever you want to order again.",
                  "hi": "ठीक है, रद्द कर दिया. फिर ऑर्डर करना हो तो Hi भेजें."},
    "voice": {"en": "Sorry, I cannot understand voice notes yet. Could you type that instead?",
              "hi": "माफ़ कीजिए, मैं अभी वॉइस नोट नहीं समझ पाता. कृपया टाइप करके भेजें."},
    "menu": {"en": "Order here: {link}", "hi": "यहाँ से ऑर्डर करें: {link}"},
    "status": {"en": "Order {code}: {status}. Track: {link}", "hi": "ऑर्डर {code}: {status}. ट्रैक करें: {link}"},
    "no_orders": {"en": "You have no orders yet. Send 'menu' to order.", "hi": "अभी कोई ऑर्डर नहीं है. ऑर्डर के लिए 'menu' भेजें."},
    "thanks5": {"en": "Thank you! We are glad you enjoyed it.", "hi": "धन्यवाद! हमें खुशी है कि आपको पसंद आया."},
    "sorry": {"en": "We are sorry to hear that. What could we have done better? Reply with a few words, or SKIP.",
              "hi": "यह सुनकर खेद है. हम क्या बेहतर कर सकते थे? कुछ शब्द लिखें, या SKIP."},
    "fb_thanks": {"en": "Thank you. We have passed this to the team.", "hi": "धन्यवाद. हमने यह टीम तक पहुँचा दिया है."},
    "fb_skip": {"en": "No problem, thanks for the rating.", "hi": "कोई बात नहीं, रेटिंग के लिए धन्यवाद."},
}


def t(ctx: dict, key: str, **kw) -> str:
    lang = ctx.get("lang", "en") if settings.delivery_enable_languages else "en"
    return M[key][lang].format(**kw)


def _is_button(text: str) -> bool:
    low = text.strip().lower()
    return any(low == w or low.startswith(w + " ") for w in BUTTON_WORDS)


def handle_inbound(db: Session, restaurant_id: str, ev: InboundMessageEvent) -> bool:
    """Returns False for a duplicate provider message id."""
    label = {"audio": "[voice note]", "location": "[location]", "image": "[image]"}.get(ev.kind, "")
    try:
        with db.begin_nested():
            db.add(InboundMessage(restaurant_id=restaurant_id, provider_message_id=ev.provider_message_id,
                                  wa_number=ev.from_number, text=(ev.text or label)[:2000]))
    except IntegrityError:
        return False
    convo = db.scalar(select(Conversation).where(Conversation.restaurant_id == restaurant_id,
                                                 Conversation.wa_number == ev.from_number))
    if not convo:
        convo = Conversation(restaurant_id=restaurant_id, wa_number=ev.from_number, context={})
        db.add(convo)
    ctx = dict(convo.context or {})

    kw = consent.keyword(ev.text) if ev.kind == "text" else None
    if kw or consent.is_opted_out(db, restaurant_id, ev.from_number):
        if kw == "stop":
            consent.set_opt(db, restaurant_id, ev.from_number, True)
            body = consent.OPT_OUT_REPLY
        elif kw == "start":
            consent.set_opt(db, restaurant_id, ev.from_number, False)
            body = consent.OPT_IN_REPLY
        else:
            body = consent.STILL_OUT_REPLY
        # The reply to the keyword itself is the one message an opted-out number may get (it is asked for).
        notify.enqueue_message(db, restaurant_id, ev.from_number, "text_reply", body=body)
        return True

    if settings.delivery_enable_languages and ev.text and DEVANAGARI.search(ev.text) and "lang" not in ctx:
        ctx["lang"] = "hi"
    ctx["wa"] = ev.from_number
    reply = _route(db, restaurant_id, ev, ctx)
    convo.context = ctx  # new dict: JSON column change detection
    if reply:
        notify.enqueue_message(db, restaurant_id, ev.from_number, "text", body=reply)
    return True


def _route(db: Session, rid: str, ev: InboundMessageEvent, ctx: dict) -> str:
    if ev.kind == "audio":  # never guessed at as empty text; the state is left untouched
        return t(ctx, "voice")
    if ev.kind == "location":
        return _on_pin(db, rid, ctx, ev.lat, ev.lng)
    text = (ev.text or "").strip()
    low = text.lower()
    if settings.delivery_enable_languages:
        if low in ("hindi", "हिंदी", "हिन्दी"):
            ctx["lang"] = "hi"
        elif low == "english":
            ctx["lang"] = "en"
    if low in ("cancel", "reset", "रद्द", "रद्द करें"):
        lang = ctx.get("lang")
        ctx.clear()
        if lang:
            ctx["lang"] = lang
        return t(ctx, "cancelled")
    if low in ("status", "track", "स्टेटस"):
        return _status(db, rid, ev.from_number, ctx)

    awaiting = ctx.get("awaiting")
    if awaiting in ("rating", "rating_feedback"):
        done = _on_rating(db, rid, ctx, text, awaiting)
        if done is not None:
            return done
        ctx.pop("awaiting", None)  # not a rating: the question ends, carry on normally
        ctx.pop("rating_order", None)
        awaiting = None
    if low in ("menu", "मेनू", "मेन्यू"):
        return t(ctx, "menu", link=svc.menu_link(rid, ev.from_number))
    handler = {"saved_address": _on_saved, "address": _on_address, "name": _on_name, "location": _on_location_text,
               "payment": _on_payment}.get(awaiting or "")
    if handler:
        return handler(db, rid, ev, ctx, text)
    return _start(db, rid, ev.from_number, ctx)


def _brand(db, rid) -> str:
    r = db.get(Restaurant, rid)
    return (r.brand_name if r and r.brand_name else "us")


def _start(db, rid, number, ctx) -> str:
    ctx.pop("details", None)
    last = db.scalar(select(DeliveryOrder).where(DeliveryOrder.restaurant_id == rid, DeliveryOrder.wa_number == number)
                     .order_by(DeliveryOrder.created_at.desc()).limit(1))
    if last and last.address_text:
        ctx.update(awaiting="saved_address", details={"name": last.customer_name, "address": last.address_text,
                                                      "lat": last.lat, "lng": last.lng})
        return t(ctx, "saved", address=last.address_text[:120])
    ctx.update(awaiting="address", details={})
    return t(ctx, "greet_addr", brand=_brand(db, rid))


def _on_saved(db, rid, ev, ctx, text) -> str:
    if text.strip().lower() in ("yes", "y", "haan", "हाँ", "हां"):
        return _after_name(db, rid, ev, ctx) if ctx["details"].get("name") else _ask(ctx, "name", "ask_name")
    ctx["details"] = {}
    ctx["awaiting"] = "address"
    if _is_button(text):
        return t(ctx, "greet_addr", brand=_brand(db, rid))
    return _on_address(db, rid, ev, ctx, text)


def _ask(ctx, state, key) -> str:
    ctx["awaiting"] = state
    return t(ctx, key)


def _on_address(db, rid, ev, ctx, text) -> str:
    pin = geo.pin_from_text(text)
    if pin:  # a maps link instead of an address
        return _on_pin(db, rid, ctx, *pin) if ctx.get("details", {}).get("address") else t(ctx, "bad_addr")
    if len(text) < 6 or not re.match(r"[A-Za-z0-9ऀ-ॿ]", text) or _is_button(text):
        return t(ctx, "bad_addr")
    ctx.setdefault("details", {})["address"] = text[:500]
    ctx["details"].pop("lat", None)
    ctx["details"].pop("lng", None)
    return _ask(ctx, "name", "ask_name")


def _on_name(db, rid, ev, ctx, text) -> str:
    if not NAME_RE.fullmatch(text) or _is_button(text):
        return t(ctx, "bad_name")
    ctx["details"]["name"] = text[:100]
    return _after_name(db, rid, ev, ctx)


def _after_name(db, rid, ev, ctx) -> str:
    d = ctx["details"]
    if geo.valid_pin(d.get("lat"), d.get("lng")):
        return _check_pin(db, rid, ctx, d["lat"], d["lng"])
    required = geo.delivery_check(svc.cached_config(db, rid), 0.1, 0.1)[0] != "unchecked"
    ctx["awaiting"] = "location"
    ctx["loc_required"] = required
    return t(ctx, "ask_pin" if required else "ask_pin_opt")


def _on_location_text(db, rid, ev, ctx, text) -> str:
    if not ctx.get("loc_required") and text.lower() in ("skip", "छोड़ें", "skip करें"):
        return _ask_payment(db, rid, ctx)
    pin = geo.pin_from_text(text)
    if not pin:
        return t(ctx, "bad_pin")
    return _check_pin(db, rid, ctx, *pin)


def _on_pin(db, rid, ctx, lat, lng) -> str:
    if not geo.valid_pin(lat, lng):
        return t(ctx, "bad_pin")
    if ctx.get("awaiting") in ("location", "address", "name", "payment", "saved_address") and ctx.get("details", {}).get("address"):
        return _check_pin(db, rid, ctx, lat, lng)
    ctx.setdefault("details", {}).update(lat=lat, lng=lng)  # remembered for the next order; the rider gets it via the order
    return t(ctx, "pin_saved")


def _check_pin(db, rid, ctx, lat, lng) -> str:
    cfg = svc.cached_config(db, rid)
    state, km = geo.delivery_check(cfg, lat, lng)
    if state == "outside":
        ctx["awaiting"] = "location"
        ctx["loc_required"] = True
        ctx["details"].pop("lat", None)  # a spot we cannot serve is not kept
        ctx["details"].pop("lng", None)
        return t(ctx, "outside", radius=f"{float(cfg['delivery_radius_km']):g}", km=f"{km:.1f}")
    ctx["details"].update(lat=lat, lng=lng)
    head = t(ctx, "pin_ok", km=f"{km:.1f}") if km is not None else t(ctx, "pin_saved")
    return head + "\n" + _ask_payment(db, rid, ctx)


def _ask_payment(db, rid, ctx) -> str:
    cod, online = svc.payment_modes(svc.cached_config(db, rid))
    if cod and online:
        ctx["awaiting"] = "payment"
        return t(ctx, "ask_pay")
    note = t(ctx, "no_online" if cod else "no_cod")
    return note + "\n" + _finish(db, rid, ctx, "cod" if cod else "online")


def _on_payment(db, rid, ev, ctx, text) -> str:
    low = text.strip().lower()
    cod, online = svc.payment_modes(svc.cached_config(db, rid))
    if low in ("1", "cod", "cash", "cash on delivery"):
        return _finish(db, rid, ctx, "cod") if cod else (t(ctx, "no_cod") + "\n" + _finish(db, rid, ctx, "online"))
    if low in ("2", "online", "pay online", "upi"):
        return _finish(db, rid, ctx, "online") if online else (t(ctx, "no_online") + "\n" + _finish(db, rid, ctx, "cod"))
    return t(ctx, "pay_bad")


def _finish(db, rid, ctx, pay) -> str:
    ctx["details"]["pay"] = pay
    ctx["awaiting"] = None
    ctx.pop("loc_required", None)
    rest = db.get(Restaurant, rid)
    qr = f" ({rest.payment_qr_url})" if pay == "online" and rest and rest.payment_qr_url else ""
    head = t(ctx, "pay_cod") if pay == "cod" else t(ctx, "pay_online", qr=qr)
    return head + "\n" + t(ctx, "ready", name=ctx["details"].get("name", ""), link=svc.menu_link(rid, ctx["wa"]))


def _status(db, rid, number, ctx) -> str:
    o = db.scalar(select(DeliveryOrder).where(DeliveryOrder.restaurant_id == rid, DeliveryOrder.wa_number == number)
                  .order_by(DeliveryOrder.created_at.desc()).limit(1))
    if not o:
        return t(ctx, "no_orders")
    return t(ctx, "status", code=o.order_code, status=o.status.replace("_", " "), link=svc.track_link(o))


def _on_rating(db, rid, ctx, text, awaiting) -> str | None:
    """None = this message is not an answer to the rating question."""
    if awaiting == "rating":
        r = ratings.parse_rating(text)
        if r is None:
            return None
        order = ratings.save(db, rid, ctx.get("rating_order"), r)
        if order is None or r >= 4:
            ctx.pop("awaiting", None)
            ctx.pop("rating_order", None)
            return t(ctx, "thanks5")
        ctx["awaiting"] = "rating_feedback"
        return t(ctx, "sorry")
    order_id = ctx.pop("rating_order", None)
    ctx.pop("awaiting", None)
    if text.strip().lower() in ("skip", "छोड़ें"):
        return t(ctx, "fb_skip")
    if order_id:
        ratings.add_feedback(db, rid, order_id, text)
    return t(ctx, "fb_thanks")
