"""Testing-phase wake-word samples (docs/VOICE_WAKE_SAMPLES.md, revision b8d2f4a6c0e3).

voice_wake_samples: TEXT ONLY. One row per sample the Chilli Agent business app sent while the owner's own testers try the
wake word: the normalised `heard` string (lower case, no digits, no e-mail / URL tokens, at most 120 characters), whether it
matched, whether it was the wake word or a command, and the device label the app sent. No IP, no audio, no user free text.
Tenant table (RLS: app/core/rls.py), kept 30 days: POST /voice/wake-samples deletes the restaurant's older rows as it writes."""
import uuid
from datetime import datetime

from sqlalchemy import Boolean, CheckConstraint, DateTime, ForeignKey, Index, String, func, text as text_
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base
from app.models.base import uuid_pk

NEW_TABLES: tuple[str, ...] = ("voice_wake_samples",)


class VoiceWakeSample(Base):
    __tablename__ = "voice_wake_samples"
    __table_args__ = (
        CheckConstraint("kind IN ('wake', 'command')", name="ck_voice_wake_samples_kind"),
        Index("ix_voice_wake_samples_rest_created", "restaurant_id", "created_at"),
    )
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("restaurants.id"))
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"))
    device: Mapped[str] = mapped_column(String(64), server_default=text_("''"))
    heard: Mapped[str] = mapped_column(String(120))
    matched: Mapped[bool] = mapped_column(Boolean)
    kind: Mapped[str] = mapped_column(String(10))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


__all__ = ["VoiceWakeSample", "NEW_TABLES"]
