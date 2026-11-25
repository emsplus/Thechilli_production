"""Table QR codes and guest reviews (docs/TABLE_QR_REVIEWS.md, revision c5e7a9b1d3f6).

* table_qr_settings: one row per restaurant (created on first use): menu QR on/off, reviews on/off, optional Google review
  link shown after a 5-star review, and the generation of the restaurant-wide ("general") QR codes.
* table_qr_links: one row per table whose QR codes were regenerated at least once (no row = generation 1). The generation is
  signed into every QR token, so bumping it kills every QR printed before.
* table_reviews: what a guest sent from a review QR. restaurant_id and table_id come from the signed token, never from the
  request body. Contact fields are optional and only what the guest typed; no IP address, no user agent, no cookie.
All three are tenant tables (RLS: app/core/rls.py TABLE_QR_TABLES)."""
import uuid
from datetime import datetime

from sqlalchemy import Boolean, CheckConstraint, DateTime, ForeignKey, Index, Integer, SmallInteger, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base
from app.models.base import uuid_pk

NEW_TABLES: tuple[str, ...] = ("table_qr_settings", "table_qr_links", "table_reviews")
REVIEW_COMMENT_MAX = 500


class TableQrSettings(Base):
    __tablename__ = "table_qr_settings"
    restaurant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("restaurants.id"), primary_key=True)
    menu_enabled: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    reviews_enabled: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    google_review_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    general_gen: Mapped[int] = mapped_column(Integer, default=1, server_default="1")
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class TableQrLink(Base):
    __tablename__ = "table_qr_links"
    __table_args__ = (CheckConstraint("gen BETWEEN 1 AND 65535", name="ck_table_qr_links_gen"),)
    table_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("dining_tables.id", ondelete="CASCADE"),
                                                primary_key=True)
    restaurant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("restaurants.id"), index=True)
    gen: Mapped[int] = mapped_column(Integer, default=1, server_default="1")
    rotated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class TableReview(Base):
    __tablename__ = "table_reviews"
    __table_args__ = (
        CheckConstraint("rating BETWEEN 1 AND 5", name="ck_table_reviews_rating"),
        CheckConstraint(f"comment IS NULL OR char_length(comment) <= {REVIEW_COMMENT_MAX}", name="ck_table_reviews_comment_len"),
        Index("ix_table_reviews_rest_created", "restaurant_id", "created_at"),
        Index("ix_table_reviews_rest_table", "restaurant_id", "table_id"),
    )
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("restaurants.id"))
    outlet_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    # NULL = the restaurant-wide review QR. SET NULL keeps a review when its table is deleted; the label snapshot stays.
    table_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("dining_tables.id", ondelete="SET NULL"),
                                                       nullable=True)
    table_label: Mapped[str | None] = mapped_column(String(50), nullable=True)
    rating: Mapped[int] = mapped_column(SmallInteger)
    comment: Mapped[str | None] = mapped_column(String(REVIEW_COMMENT_MAX), nullable=True)
    guest_name: Mapped[str | None] = mapped_column(String(80), nullable=True)
    guest_contact: Mapped[str | None] = mapped_column(String(120), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    # When an owner / manager saw it (Reviews page or the bell's "mark read"); low ratings without it count in the bell.
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


__all__ = ["TableQrSettings", "TableQrLink", "TableReview", "NEW_TABLES", "REVIEW_COMMENT_MAX"]
