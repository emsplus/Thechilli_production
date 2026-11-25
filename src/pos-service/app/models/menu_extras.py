"""Modifier groups, combos and offers (docs/MODIFIERS_OFFERS.md). All optional: a restaurant that configures none of them
sees exactly the old menu, order and bill behaviour.

Every table carries `restaurant_id` (RLS, app/core/rls.py LATER_DIRECT_TABLES, revision e3c5a7b9d1f4). Removed options,
groups and offers are DEACTIVATED, never deleted: order lines and bills keep a JSON snapshot of what was sold anyway.
Money in this module is integer PAISE (`price_delta_paise`) for modifier deltas; offer values use the app's MONEY type
(rupees with 2 decimals) like every other bill amount."""
import uuid
from datetime import date, time
from decimal import Decimal

from sqlalchemy import (
    JSON, Boolean, CheckConstraint, Date, ForeignKey, ForeignKeyConstraint, Index, Integer, Numeric, String, Time,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin, fk, uuid_pk

MONEY = Numeric(12, 2)

OFFER_KINDS = ("percent", "amount")
OFFER_SCOPES = ("bill", "item", "category")


class ModifierGroup(Base, TimestampMixin):
    """A choice the guest makes for an item: 'Spice level' (min 1, max 1 = required single choice) or 'Extras' (min 0, max 3).
    max_select NULL = no upper limit."""
    __tablename__ = "modifier_groups"
    __table_args__ = (
        CheckConstraint("min_select >= 0", name="ck_modifier_groups_min"),
        CheckConstraint("max_select IS NULL OR (max_select >= 1 AND max_select >= min_select)", name="ck_modifier_groups_max"),
    )
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    name: Mapped[str] = mapped_column(String(100))
    min_select: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    max_select: Mapped[int | None] = mapped_column(Integer, default=1, server_default="1")
    sort_order: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    options: Mapped[list["ModifierOption"]] = relationship(
        back_populates="group", cascade="all, delete-orphan", order_by="(ModifierOption.sort_order, ModifierOption.name)")


class ModifierOption(Base, TimestampMixin):
    __tablename__ = "modifier_options"
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    group_id: Mapped[uuid.UUID] = fk("modifier_groups")
    name: Mapped[str] = mapped_column(String(100))
    # Integer paise added to the line's unit price (may be negative, e.g. 'No cheese'); the line price never goes below 0.
    price_delta_paise: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    # Selected automatically when an order line does not send `modifiers` at all (old clients, the counter fast path, voice).
    is_default: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    sort_order: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    group: Mapped[ModifierGroup] = relationship(back_populates="options")


class MenuItemModifierGroup(Base):
    """Which groups an item offers, in order. Replaced as a set (PUT /menu/items/{id}/modifier-groups)."""
    __tablename__ = "menu_item_modifier_groups"
    item_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("menu_items.id", ondelete="CASCADE"),
                                               primary_key=True)
    group_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("modifier_groups.id", ondelete="CASCADE"),
                                                primary_key=True, index=True)
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    sort_order: Mapped[int] = mapped_column(Integer, default=0, server_default="0")


class ComboComponent(Base):
    """A component of a combo item. The combo itself is an ordinary menu item (its own price, tax kind, GST fields and
    category), so ordering / billing / tax need nothing new; components go to the kitchen ticket and drive stock usage
    when the combo has no recipe of its own. Replaced as a set (PUT /menu/items/{id}/combo)."""
    __tablename__ = "combo_components"
    __table_args__ = (CheckConstraint("quantity >= 1", name="ck_combo_components_qty"),
                      CheckConstraint("combo_item_id <> component_item_id", name="ck_combo_components_not_self"))
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    combo_item_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("menu_items.id", ondelete="CASCADE"),
                                                     index=True)
    component_item_id: Mapped[uuid.UUID] = fk("menu_items")
    variant_id: Mapped[uuid.UUID | None] = fk("menu_variants", nullable=True)
    quantity: Mapped[int] = mapped_column(Integer, default=1, server_default="1")
    sort_order: Mapped[int] = mapped_column(Integer, default=0, server_default="0")


class Offer(Base, TimestampMixin):
    """An automatic discount (docs/MODIFIERS_OFFERS.md): percent or amount off the bill, some items or some categories,
    inside a date / weekday / time-of-day window, above a minimum order value. Applied by the server at bill preview and
    finalize. Offers do not stack unless `stackable` (the best non-stackable offer wins; stackable ones add to it)."""
    __tablename__ = "offers"
    __table_args__ = (
        CheckConstraint("kind IN ('percent', 'amount')", name="ck_offers_kind"),
        CheckConstraint("scope IN ('bill', 'item', 'category')", name="ck_offers_scope"),
        CheckConstraint("value > 0 AND (kind <> 'percent' OR value <= 100)", name="ck_offers_value"),
        ForeignKeyConstraint(["outlet_id", "restaurant_id"], ["outlets.id", "outlets.restaurant_id"], name="fk_offers_outlet"),
        Index("ix_offers_restaurant_active", "restaurant_id", "is_active"),
    )
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    outlet_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True, index=True)  # NULL = every outlet
    name: Mapped[str] = mapped_column(String(100))  # printed as 'Offer: <name>'
    kind: Mapped[str] = mapped_column(String(10))  # percent | amount
    value: Mapped[Decimal] = mapped_column(MONEY)  # percent (0-100] or amount in the bill currency
    scope: Mapped[str] = mapped_column(String(10), default="bill", server_default="bill")  # bill | item | category
    target_ids: Mapped[list | None] = mapped_column(JSON)  # item / category ids (strings) for scope item / category
    min_order_value: Mapped[Decimal] = mapped_column(MONEY, default=0, server_default="0")
    max_discount: Mapped[Decimal | None] = mapped_column(MONEY)  # cap of the offer's discount on one bill
    days_of_week: Mapped[list | None] = mapped_column(JSON)  # [0..6], Monday = 0; NULL = every day
    start_time: Mapped[time | None] = mapped_column(Time)  # outlet-local; both NULL = all day; start > end spans midnight
    end_time: Mapped[time | None] = mapped_column(Time)
    valid_from: Mapped[date | None] = mapped_column(Date)  # outlet-local dates, inclusive
    valid_to: Mapped[date | None] = mapped_column(Date)
    order_types: Mapped[list | None] = mapped_column(JSON)  # e.g. ["takeaway"]; NULL = every order type
    stackable: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    priority: Mapped[int] = mapped_column(Integer, default=0, server_default="0")  # tie-break / stacking order (higher first)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    created_by: Mapped[uuid.UUID | None] = fk("users", nullable=True)


NEW_TABLES: tuple[str, ...] = ("modifier_groups", "modifier_options", "menu_item_modifier_groups", "combo_components", "offers")
