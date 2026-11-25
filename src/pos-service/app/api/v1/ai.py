import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field, computed_field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.deps import require_feature, P, Principal, require_perm
from app.core.config import settings
from app.core.db import get_db
from app.models.core import Conversation, Kot, MenuVariant, Order, OrderType, Restaurant, VoiceAlias, VoiceCommit
from app.schemas.common import ORM, OrderIn, OrderLineIn
from app.services import ai as svc, ai_providers, audit, orders as order_svc, outlets, voice_order as voice

router = APIRouter(prefix="/ai", tags=["ai"], dependencies=[Depends(require_feature("ai"))])


class ChatIn(BaseModel):
    message: str = Field(min_length=1, max_length=2000)
    conversation_id: uuid.UUID | None = None


class ChatOut(BaseModel):
    conversation_id: uuid.UUID
    answer: str
    tools_used: list[dict]
    attachments: list[dict] = []  # [{kind, title, from, to, filename, url}]: PDFs the assistant prepared; url = relative API path


class MessageOut(ORM):
    role: str
    content: str
    tool_calls: list | None
    created_at: datetime

    @computed_field
    @property
    def attachments(self) -> list[dict]:
        return svc.attachments_of(self.tool_calls)


class ConversationOut(ORM):
    id: uuid.UUID
    title: str
    created_at: datetime


class ConversationDetail(ConversationOut):
    messages: list[MessageOut]


@router.post("/chat", response_model=ChatOut)
def chat(data: ChatIn, p: Principal = Depends(require_perm(P.AI_USE)), db: Session = Depends(get_db), llm: svc.LLM = Depends(svc.get_llm)):
    conv, answer, calls = svc.chat(db, p, llm, data.message, data.conversation_id)
    return ChatOut(conversation_id=conv.id, answer=answer, tools_used=calls, attachments=svc.attachments_of(calls))


@router.get("/conversations", response_model=list[ConversationOut])
def conversations(p: Principal = Depends(require_perm(P.AI_USE)), db: Session = Depends(get_db)):
    return db.scalars(select(Conversation).where(Conversation.restaurant_id == p.restaurant_id, Conversation.user_id == p.user_id)
                      .order_by(Conversation.created_at.desc()).limit(50)).all()


@router.get("/conversations/{cid}", response_model=ConversationDetail)
def conversation(cid: uuid.UUID, p: Principal = Depends(require_perm(P.AI_USE)), db: Session = Depends(get_db)):
    c = db.get(Conversation, cid)
    if not c or c.restaurant_id != p.restaurant_id or c.user_id != p.user_id:
        raise HTTPException(404, "Conversation not found")
    return c


# ---- voice / typed order taking (POS). Read-only: returns menu references for the till's confirm sheet. ----
class VoiceLineOut(BaseModel):
    item_id: uuid.UUID
    item_name: str
    variant_id: uuid.UUID | None
    variant_name: str | None
    quantity: int
    note: str | None
    heard_text: str
    confidence: float
    needs_review: bool
    issues: list[str]
    defaulted: bool = False  # no option was said: variant_* is the dish's default (the cheapest, e.g. Half)


class VoiceCustomerOut(BaseModel):
    name: str | None
    phone: str | None  # E.164, normalised by the restaurant's country; null when missing or not a valid number
    phone_heard: str | None  # what the model heard, for the user to correct


class VoiceOptionOut(BaseModel):
    item_id: uuid.UUID
    item_name: str


class VoiceTableOptionOut(BaseModel):
    table_id: uuid.UUID
    label: str
    area: str  # indoor | outdoor


class VoiceClarificationOut(BaseModel):
    """Something the parser would not guess: ask the staff member, then send the chosen line / table to /voice-order/commit."""
    heard_text: str
    reason: str  # ambiguous_item | fractional_quantity | unclear_quantity | quantity_without_dish | ambiguous_table
    options: list[VoiceOptionOut]  # the dishes to choose from (always [] for a table clarification)
    quantity: int | None
    note: str | None
    kind: str = "dish"  # dish | table. ADDITIVE: older clients ignore it; "table" = reason ambiguous_table, see table_options
    table_options: list[VoiceTableOptionOut] = []  # kind "table": the tables that fit the label heard ("3" with AC3 and G3)


class VoiceOrderOut(BaseModel):
    parse_id: uuid.UUID | None = None  # the stored transcript (null when retention is 0)
    transcript: str | None
    lines: list[VoiceLineOut]
    unmatched: list[str]
    clarifications: list[VoiceClarificationOut] = []
    needs_clarification: bool = False  # true: do not commit until each clarification is resolved or dropped
    customer: VoiceCustomerOut
    order_type: str | None
    table_label: str | None
    table_id: uuid.UUID | None
    bill_no: int | None = None  # "bill number 2": the till's own ticket number (1-99), never a database id
    new_bill: bool = False  # "new bill" / "next bill": open a ticket with the lowest free number
    command: str | None = None  # till command said at the end: place | kot | clear (the till checks and runs it)
    model_used: bool = False  # true: the AI model was asked (provider gemini, audio or a phrase the parser was unsure of)


@router.post("/voice-order", response_model=VoiceOrderOut)
def voice_order(file: UploadFile | None = File(default=None), text: str | None = Form(default=None),
                language: str | None = Form(default=None, max_length=10),
                p: Principal = Depends(require_perm(P.VOICE_USE)),
                db: Session = Depends(get_db), model: voice.VoiceModel = Depends(voice.get_voice_model)):
    """Send ONE of: `file` (a recording, up to 10 MB: webm / ogg / mp4 / mp3 / wav) or `text` (typed order, or a
    transcript the till already made). Optional `language`: en | hi | pa | auto (what the staff member chose).
    Nothing is saved: the result only names menu items (ids from this restaurant's active menu), quantities and the
    customer heard; prices always come from the menu when the till adds the lines."""
    text = (text or "").strip() or None
    if (file is None) == (text is None):
        raise HTTPException(422, "Send a recording or a typed order")
    audio, mime = None, None
    if file is not None:
        mime = voice.audio_type(file.content_type)
        audio = file.file.read(settings.max_upload_bytes + 1)
        if not audio or len(audio) > settings.max_upload_bytes:
            raise HTTPException(413, "The recording is empty or too large (10 MB max)")
    elif len(text) > voice.MAX_TEXT:
        raise HTTPException(422, f"The typed order is too long ({voice.MAX_TEXT} characters max)")
    voice.rate_limit(p.user_id, p.restaurant_id)
    restaurant = db.get(Restaurant, p.restaurant_id)
    idx = voice.menu_index(db, p.restaurant_id)
    if not idx.items:
        raise HTTPException(409, "The menu is empty: add dishes first")
    # text with the hybrid provider is charged only when the model is really asked (below); audio always is
    hybrid = isinstance(model, voice.HybridVoiceModel)
    voice.charge_daily_cap(db, p.restaurant_id, voice.estimated_cost_micros(audio is not None) if audio is not None or not hybrid else 0)
    injected = False
    if text is not None:
        text, injected = voice.clean_text_input(text)
        if not text:
            raise HTTPException(422, "The typed order is empty")
    lang = voice.LANGUAGES.get((language or "").strip().lower())
    outlet_id = outlets.outlet_of(db, p)
    tables = voice.active_tables(db, p.restaurant_id, outlet_id)
    hints = {"aliases": _aliases(db, p.restaurant_id, idx), "tables": [(t.label, t.area.value) for t in tables]}
    if lang:
        hints["language"] = lang
        hints["lang_code"] = (language or "").strip().lower()
    if audio is not None and ai_providers.stt_provider() == "whisper" and provider_is_real(model):
        hints.update(voice.prompt_hints(db, p.restaurant_id))  # dish names that matter most, for the recogniser's vocabulary
    raw = model.parse(idx.text, audio, mime, text, **hints)
    if audio is None and hybrid and raw.get("_model_used") and voice.estimated_cost_micros(False):
        try:
            voice.charge_daily_cap(db, p.restaurant_id, voice.estimated_cost_micros(False), requests=0)
        except HTTPException:
            pass  # the answer is already paid for; the cap refuses the next request
    out = voice.interpret(db, restaurant, idx, raw, outlet_id)
    voice.store_unmatched(db, p.restaurant_id, out["unmatched"])
    out["parse_id"] = voice.store_transcript(db, p.restaurant_id, p.user_id, "audio" if audio else "text", out["transcript"] or text)
    # PII minimisation: the audit row and logs carry counts and flags only, never the transcript, names or phone numbers.
    audit.record(db, p, "ai.voice_order", "ai_voice_order", None,
                 {"source": "audio" if audio else "text", "language": language if lang else None,
                  "lines": len(out["lines"]), "unmatched": len(out["unmatched"]),
                  "clarifications": len(out["clarifications"]), "injection_suspected": injected,
                  "model_used": out["model_used"], "command": out["command"]})
    db.commit()
    return out


def provider_is_real(model) -> bool:
    return not isinstance(model, voice.FakeVoiceModel)


@router.get("/status")
def ai_status(p: Principal = Depends(require_perm(P.AI_USE))):
    """Which provider does what, as booleans and names only (never a key): {"scan": {"provider": "xai", "label": "Grok",
    "configured": true}, "voice": {...Whisper...}, "text": {...}, "keys": {gemini, xai, openai: bool}, "summary":
    "Scan: Grok, Voice: Whisper"}."""
    return ai_providers.status()


def _aliases(db: Session, restaurant_id: uuid.UUID, idx: voice.MenuIndex) -> dict[str, tuple[str, str | None]]:
    """The restaurant's learnt phrases whose dish is still on the active menu: phrase -> (item ref, option ref)."""
    out: dict[str, tuple[str, str | None]] = {}
    item_ref = {v.id: k for k, v in idx.items.items() if k.startswith("m")}
    var_ref = {v.id: k for k, v in idx.variants.items() if k.startswith("m")}
    for a in db.scalars(select(VoiceAlias).where(VoiceAlias.restaurant_id == restaurant_id)):
        if a.menu_item_id in item_ref:
            out[a.phrase] = (item_ref[a.menu_item_id], var_ref.get(a.variant_id) if a.variant_id else None)
    return out


# ---- confirm -> commit. The only place voice creates an order; idempotent on the client's op_id. ----
class VoiceCommitIn(BaseModel):
    op_id: uuid.UUID  # client-generated once per confirmation; a retry / double tap / replay reuses it
    confirmed: bool  # the staff member saw the list and pressed confirm
    order_type: OrderType
    table_id: uuid.UUID | None = None
    customer_id: uuid.UUID | None = None
    lines: list[OrderLineIn] = Field(min_length=1, max_length=voice.MAX_LINES)
    send_kot: bool = True
    parse_id: uuid.UUID | None = None


class VoiceCommitOut(BaseModel):
    order_id: uuid.UUID
    kot_id: uuid.UUID | None
    kot_number: int | None
    replayed: bool  # true: this op_id was already committed; nothing new was created


@router.post("/voice-order/commit", response_model=VoiceCommitOut)
def voice_commit(data: VoiceCommitIn, p: Principal = Depends(require_perm(P.VOICE_USE)), db: Session = Depends(get_db)):
    """Creates the order (and sends the KOT) from a CONFIRMED voice list. Items, options and prices are re-validated and
    re-priced by the normal order service; nothing the client or the model says about prices is used. Replaying the same
    `op_id` returns the first result and never creates a second order or KOT."""
    if not data.confirmed:
        raise HTTPException(422, "Staff must confirm the order before it is created")
    if not p.can(P.ORDERS_CREATE) or (data.send_kot and not p.can(P.KOT_SEND)):
        raise HTTPException(403, "Not allowed to create orders or send KOTs")

    def replay() -> VoiceCommitOut | None:
        c = db.scalar(select(VoiceCommit).where(VoiceCommit.restaurant_id == p.restaurant_id, VoiceCommit.op_id == data.op_id))
        if c is None:
            return None
        k = db.get(Kot, c.kot_id) if c.kot_id else None
        return VoiceCommitOut(order_id=c.order_id, kot_id=c.kot_id, kot_number=k.number if k else None, replayed=True)

    if (r := replay()) is not None:
        return r
    order = order_svc.create_order(db, p, OrderIn(client_uuid=data.op_id, order_type=data.order_type, table_id=data.table_id,
                                                  customer_id=data.customer_id, lines=data.lines))
    kot = None
    if data.send_kot:
        try:
            kot = order_svc.send_kot(db, p, order.id)
        except order_svc.NothingToSend:  # the order of an interrupted first attempt was already sent
            kot = db.scalars(select(Kot).where(Kot.order_id == order.id).order_by(Kot.number)).first()
    db.add(VoiceCommit(restaurant_id=p.restaurant_id, op_id=data.op_id, order_id=order.id, kot_id=kot.id if kot else None,
                       user_id=p.user_id))
    try:
        audit.record(db, p, "ai.voice_commit", "order", order.id, {"lines": len(data.lines), "kot": bool(kot)})
        db.commit()
    except IntegrityError:  # two identical requests at once: the loser returns the winner's result
        db.rollback()
        if (r := replay()) is not None:
            return r
        raise
    return VoiceCommitOut(order_id=order.id, kot_id=kot.id if kot else None, kot_number=kot.number if kot else None, replayed=False)
