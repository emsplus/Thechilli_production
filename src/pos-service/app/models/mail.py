"""Email tables (docs/EMAIL.md).

`email_otps` is GLOBAL (no tenant column, exempt from RLS like abuse_counters / login_attempts): one-time codes are asked for
and checked before any tenant exists (sign-up) or is known (password reset). The code itself is never stored, only an HMAC of
it; a sign-up row also holds the pending registration (restaurant name, owner, the password as an argon2 hash) until the code
is entered, so no tenant and no user exist before the email is proven (security review finding 1: nothing to squat).

`daily_report_emails` is a tenant table (RLS): the idempotency ledger of the end-of-day report email, one row per
(outlet, business date)."""
import uuid
from datetime import date, datetime

from sqlalchemy import Date, DateTime, ForeignKeyConstraint, Index, Integer, String, UniqueConstraint, func, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base
from app.models.base import TimestampMixin, fk, outlet_col, uuid_pk


class EmailOtp(Base):
    __tablename__ = "email_otps"
    __table_args__ = (
        Index("ix_email_otps_purpose_email", "purpose", "email"),
        Index("ix_email_otps_expires_at", "expires_at"),
    )
    id: Mapped[uuid.UUID] = uuid_pk()
    purpose: Mapped[str] = mapped_column(String(20))  # signup | password_reset
    email: Mapped[str] = mapped_column(String(254))  # lower-cased
    code_hash: Mapped[str] = mapped_column(String(64))  # HMAC-SHA256(server key, id:code); never the code
    attempts: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    sends: Mapped[int] = mapped_column(Integer, default=1, server_default="1")
    last_sent_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    payload: Mapped[dict | None] = mapped_column(JSONB)  # sign-up: the pending registration; reset: optional restaurant_id
    # Password reset: entering the code yields a short-lived single-use reset token (sha256 only) for the new-password step.
    grant_hash: Mapped[str | None] = mapped_column(String(64))
    grant_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    grant_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class DailyReportEmail(Base, TimestampMixin):
    __tablename__ = "daily_report_emails"
    __table_args__ = (
        UniqueConstraint("outlet_id", "business_date", name="uq_daily_report_emails_outlet_date"),
        ForeignKeyConstraint(["outlet_id", "restaurant_id"], ["outlets.id", "outlets.restaurant_id"],
                             name="fk_daily_report_emails_outlet"),
        Index("ix_daily_report_emails_due", "status", "updated_at", postgresql_where=text("status = 'queued'")),
    )
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    outlet_id: Mapped[uuid.UUID] = outlet_col()
    business_date: Mapped[date] = mapped_column(Date)
    trigger: Mapped[str] = mapped_column(String(10))  # schedule | z_close | manual
    status: Mapped[str] = mapped_column(String(10), default="queued", server_default="queued")  # queued|sent|skipped|failed
    attempts: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    recipients: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    error: Mapped[str | None] = mapped_column(String(300))
    z_report_id: Mapped[uuid.UUID | None] = mapped_column(nullable=True)
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


MAIL_TABLES = ("email_otps", "daily_report_emails")
__all__ = ["EmailOtp", "DailyReportEmail", "MAIL_TABLES"]
