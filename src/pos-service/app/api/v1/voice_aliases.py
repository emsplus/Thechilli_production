"""Phrases the live voice ordering learnt from staff corrections. The till's on-device parser (apps/web voiceParse.ts)
matches a learnt phrase straight to its dish; the till normalises the phrase, the server only tidies case and spaces."""
import re
import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.deps import require_feature, current_principal, P, Principal, require_perm
from app.core.db import get_db
from app.models.core import MenuItem, MenuVariant, VoiceAlias
from app.services import audit

router = APIRouter(prefix="/menu/voice-aliases", tags=["menu"])
# Whoever may take a voice order may teach it (same roles as POST /ai/voice-order); forgetting a phrase is back office.
# The plan gate (`voice` -> ai.copilot) is on the WRITES only. The list is a search aid every till and the waiter app loads with the
# menu (smoke 2026-11-01: a waiter on a plan without voice got a 403 on every menu load); it is the restaurant's own data, so any
# signed-in role may read it (an empty list when nothing was ever learnt).
voice_plan = Depends(require_feature("voice"))


def normalise(phrase: str) -> str:
    return re.sub(r"\s+", " ", phrase).strip().lower()


class AliasIn(BaseModel):
    phrase: str = Field(min_length=1, max_length=200)
    menu_item_id: uuid.UUID
    variant_id: uuid.UUID | None = None

    @field_validator("phrase")
    @classmethod
    def _tidy(cls, v: str) -> str:
        v = normalise(v)
        if not v:
            raise ValueError("Phrase is empty")
        return v


class AliasOut(BaseModel):
    id: uuid.UUID
    phrase: str
    menu_item_id: uuid.UUID
    item_name: str
    item_active: bool
    variant_id: uuid.UUID | None
    variant_name: str | None
    uses: int
    created_by: uuid.UUID | None
    created_at: datetime
    updated_at: datetime


def _out(a: VoiceAlias) -> AliasOut:
    v = a.variant if a.variant and a.variant.is_active else None
    return AliasOut(id=a.id, phrase=a.phrase, menu_item_id=a.menu_item_id, item_name=a.item.name, item_active=a.item.is_active,
                    variant_id=v.id if v else None, variant_name=v.name if v else None, uses=a.uses,
                    created_by=a.created_by, created_at=a.created_at, updated_at=a.updated_at)


@router.get("", response_model=list[AliasOut])
def list_aliases(p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """Every learnt phrase of the restaurant, archived dishes included (`item_active` false: the till ignores those)."""
    rows = db.scalars(select(VoiceAlias).where(VoiceAlias.restaurant_id == p.restaurant_id).order_by(VoiceAlias.phrase)).all()
    return [_out(a) for a in rows]


@router.put("", response_model=AliasOut, dependencies=[voice_plan])
def learn(data: AliasIn, p: Principal = Depends(require_perm(P.VOICE_USE)), db: Session = Depends(get_db)):
    """Upsert by phrase. The same dish again counts one more use; another dish replaces the old one (uses restart at 1)."""
    item = db.get(MenuItem, data.menu_item_id)
    if not item or item.restaurant_id != p.restaurant_id:
        raise HTTPException(404, "Item not found")
    if not item.is_active:
        raise HTTPException(422, "That dish is archived")
    if data.variant_id is not None:
        v = db.get(MenuVariant, data.variant_id)
        if not v or v.item_id != item.id or not v.is_active:
            raise HTTPException(422, "That option does not belong to this dish")
    q = select(VoiceAlias).where(VoiceAlias.restaurant_id == p.restaurant_id, VoiceAlias.phrase == data.phrase)
    a = db.scalar(q.with_for_update())
    if a is None:
        try:
            with db.begin_nested():  # two tills learning the same phrase at once: the loser updates the winner's row
                a = VoiceAlias(restaurant_id=p.restaurant_id, phrase=data.phrase, menu_item_id=item.id,
                               variant_id=data.variant_id, uses=1, created_by=p.user_id)
                db.add(a)
            audit.record(db, p, "voice_alias.learn", "voice_alias", a.id,
                         {"phrase": data.phrase, "item": item.name, "variant_id": str(data.variant_id) if data.variant_id else None})
            db.commit()
            db.refresh(a)
            return _out(a)
        except IntegrityError:
            a = db.scalar(q.with_for_update())
    if (a.menu_item_id, a.variant_id) == (item.id, data.variant_id):
        a.uses += 1
    else:
        audit.record(db, p, "voice_alias.learn", "voice_alias", a.id,
                     {"phrase": data.phrase, "item": item.name, "old_item_id": str(a.menu_item_id),
                      "variant_id": str(data.variant_id) if data.variant_id else None})
        a.menu_item_id, a.variant_id, a.uses = item.id, data.variant_id, 1
    db.commit()
    db.refresh(a)
    return _out(a)


@router.delete("/{alias_id}", status_code=204, dependencies=[voice_plan])
def forget(alias_id: uuid.UUID, p: Principal = Depends(require_perm(P.MENU_MANAGE)), db: Session = Depends(get_db)):
    a = db.get(VoiceAlias, alias_id)
    if not a or a.restaurant_id != p.restaurant_id:
        raise HTTPException(404, "Phrase not found")
    audit.record(db, p, "voice_alias.delete", "voice_alias", a.id, {"phrase": a.phrase, "item_id": str(a.menu_item_id)})
    db.delete(a)
    db.commit()
    return Response(status_code=204)
