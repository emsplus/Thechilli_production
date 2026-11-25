"""Testing-phase wake-word samples (docs/VOICE_WAKE_SAMPLES.md). The Chilli Agent business app sends TEXT-ONLY samples of what it
heard while the owner's own testers try the wake word, and fetches the wake variants learned for its own restaurant.

Switch: VOICE_SAMPLES_ENABLED (default false). Off: GET /voice/wake-config answers share_samples=false with no variants and POST
/voice/wake-samples is a 404. Any signed-in staff member of the restaurant may call both (no permission, no plan gate)."""
from datetime import timedelta
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.api.deps import Principal, current_principal
from app.core.config import settings
from app.core.db import get_db
from app.services import abuse, voice_wake

router = APIRouter(prefix="/voice", tags=["voice"])


class WakeConfigOut(BaseModel):
    share_samples: bool
    variants: list[str]


class SampleIn(BaseModel):
    heard: str = Field(max_length=120)
    matched: bool
    kind: Literal["wake", "command"]
    device: str = Field(max_length=64)


class SamplesIn(BaseModel):
    samples: list[SampleIn] = Field(max_length=50)


def _enabled_principal(p: Principal = Depends(current_principal)) -> Principal:
    if not settings.voice_samples_enabled:
        raise HTTPException(404, "Not found")  # runs before the body is validated: off means the route does not exist
    return p


@router.get("/wake-config", response_model=WakeConfigOut)
def wake_config(p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """share_samples mirrors VOICE_SAMPLES_ENABLED; variants are THIS restaurant's learned wake phrases (empty when off)."""
    if not settings.voice_samples_enabled:
        return WakeConfigOut(share_samples=False, variants=[])
    return WakeConfigOut(share_samples=True, variants=voice_wake.variants(db, p.restaurant_id))


@router.post("/wake-samples", status_code=204)
def wake_samples(data: SamplesIn, p: Principal = Depends(_enabled_principal), db: Session = Depends(get_db)):
    """Stores the cleaned text of up to 50 samples (see services/voice_wake.clean_heard); 429 beyond the per-user hourly limit."""
    abuse.throttle([(f"voice-samples:user:{p.user_id}", settings.voice_samples_per_user_per_hour)], window=timedelta(hours=1),
                   what="sample uploads")
    voice_wake.store(db, p.restaurant_id, p.user_id, [s.model_dump() for s in data.samples])
    db.commit()
    return Response(status_code=204)
