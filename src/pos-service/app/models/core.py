import enum
import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    Boolean, CheckConstraint, Date, LargeBinary, DateTime, Enum, ForeignKey, ForeignKeyConstraint, Index, Integer, JSON, Numeric, String, Text,
    UniqueConstraint, func, text as text_,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin, fk, outlet_col, uuid_pk

MONEY = Numeric(12, 2)
QTY = Numeric(12, 3)
# API-relative URL prefix of menu photos (served publicly by app/api/v1/media.py).
MENU_MEDIA_PREFIX = "/api/v1/media/menu"


class Role(str, enum.Enum):
    owner = "owner"
    manager = "manager"
    cashier = "cashier"
    waiter = "waiter"
    kitchen = "kitchen"


class OrderType(str, enum.Enum):
    indoor = "indoor"
    outdoor = "outdoor"
    takeaway = "takeaway"
    delivery = "delivery"


class OrderStatus(str, enum.Enum):
    open = "open"
    sent_to_kitchen = "sent_to_kitchen"
    billed = "billed"
    cancelled = "cancelled"


class KotStatus(str, enum.Enum):
    pending = "pending"
    preparing = "preparing"
    ready = "ready"
    served = "served"
    cancelled = "cancelled"


# India only (owner decision 2026-10-31, app/services/localisation.py): the CHECK constraints below (revision
# 7c3e9a1f5b2d) make the database itself refuse any other country or currency.
CK_INR = "currency = 'INR'"
CK_IN = "country = 'IN'"


# Restaurant login codes (docs/STAFF_WIRING_CHECK.md): 6 characters without look-alikes (no 0/O, 1/I/L), ~887 million codes.
LOGIN_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
LOGIN_CODE_LENGTH = 6


def new_login_code() -> str:
    import secrets
    return "".join(secrets.choice(LOGIN_CODE_ALPHABET) for _ in range(LOGIN_CODE_LENGTH))


class Restaurant(Base, TimestampMixin):
    __tablename__ = "restaurants"
    __table_args__ = (CheckConstraint(CK_INR, name="ck_restaurants_currency_inr"),
                      CheckConstraint(CK_IN, name="ck_restaurants_country_in"),
                      CheckConstraint(
                          "jsonb_typeof(business_types) = 'array' AND jsonb_array_length(business_types) >= 1 "
                          "AND business_types <@ '[\"restaurant\", \"cloud_kitchen\", \"hotel_kitchen\"]'::jsonb",
                          name="ck_restaurants_business_types"),
                      CheckConstraint("kitchen_target_minutes BETWEEN 5 AND 120", name="ck_restaurants_kitchen_target_minutes"),
                      CheckConstraint("kitchen_status_mode IN ('kot_only', 'track')", name="ck_restaurants_kitchen_status_mode"),
                      CheckConstraint("kitchen_display_minutes BETWEEN 5 AND 120", name="ck_restaurants_kitchen_display_minutes"))
    id: Mapped[uuid.UUID] = uuid_pk()
    name: Mapped[str] = mapped_column(String(200))
    # Short public code staff type at sign-in (restaurant code + phone / username / email + password). Not a secret: it only
    # picks the tenant, the password still decides. Unique across tenants; set at creation (revision b4d6f8a0c2e7 backfills).
    login_code: Mapped[str] = mapped_column(String(8), unique=True, default=new_login_code)
    trn: Mapped[str | None] = mapped_column(String(20))  # the GSTIN (column name kept for API compatibility)
    address: Mapped[str | None] = mapped_column(String(500))
    phone: Mapped[str | None] = mapped_column(String(30))  # printed on bills and Z/X reports
    # India only: always IN / INR / Asia/Kolkata (CHECK constraints above; server defaults set by revision f1a2b3c4d5e6).
    currency: Mapped[str] = mapped_column(String(3), default="INR", server_default="INR")
    timezone: Mapped[str] = mapped_column(String(64), default="Asia/Kolkata", server_default="Asia/Kolkata")
    country: Mapped[str] = mapped_column(String(2), default="IN", server_default="IN")
    prices_include_tax: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    # GST-registered seller (column name kept for API compatibility): false = no tax charged, document titled BILL (also when there is no GSTIN).
    vat_registered: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    service_charge_percent: Mapped[Decimal] = mapped_column(Numeric(5, 2), default=0, server_default="0")
    max_cashier_discount_percent: Mapped[Decimal] = mapped_column(Numeric(5, 2), default=10, server_default="10")
    # First Z-report number to issue (continues the old till's sequence). Editable only before the first Z exists.
    z_report_next_number: Mapped[int] = mapped_column(Integer, default=1, server_default="1")
    # A finalized bill can be corrected (credit note + replacement invoice) for this many days after its sale date.
    # 0 = corrections disabled. Owner-editable (max 366).
    bill_amend_days: Mapped[int] = mapped_column(Integer, default=30, server_default="30")
    # Supplier re-order emails (services/reorder.py): one switch for the whole restaurant and the minimum gap between two
    # automatic emails to the same supplier.
    auto_reorder_emails: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    reorder_email_window_hours: Mapped[int] = mapped_column(Integer, default=12, server_default="12")
    # Stock may only go below zero when this is true (docs/INVENTORY.md). Default true = the behaviour before the setting
    # existed (sales never blocked); false makes every posting that would take a location below zero fail with 409.
    allow_negative_stock: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    # Communications (docs/COMMS.md), both OFF by default: 'new device sign-in' emails to staff, and WhatsApp messages to customers.
    login_alert_emails: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    whatsapp_enabled: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    # India GST engine (app/services/gst.py). tax_mode 'off' (default: the generic engine) | 'gst_engine' (country IN only).
    # gst_config holds every legal/policy choice as explicit per-restaurant configuration (docs/GST_INTEGRATION.md).
    tax_mode: Mapped[str] = mapped_column(String(12), default="off", server_default="off")
    gst_config: Mapped[dict | None] = mapped_column(JSON(none_as_null=True))
    # The restaurant's UPI id (VPA, e.g. thechilli@okhdfc) for static UPI QR codes; the setup checklist's "UPI" step reads
    # it. Optional; null = not set (revision e2b7c9d4f6a1).
    upi_vpa: Mapped[str | None] = mapped_column(String(100))
    # End of day report email (docs/EMAIL.md, revision a6e1d2c3b4f5): on by default, sent at daily_report_time (HH:MM, each
    # outlet's local time) and when a Z report is closed; one email per (outlet, business date) whichever comes first.
    daily_report_email: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    daily_report_time: Mapped[str] = mapped_column(String(5), default="23:00", server_default="23:00")
    daily_report_on_close: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    # What the business runs (docs/BUSINESS_TYPES.md): one or more of restaurant | cloud_kitchen | hotel_kitchen, canonical
    # order, never empty. Drives the capabilities (app/services/business_type.py). Revision a7c3e9f1b2d4.
    business_types: Mapped[list[str]] = mapped_column(JSONB, default=lambda: ["restaurant"],
                                                      server_default=text_("'[\"restaurant\"]'::jsonb"))
    # The owner's feature switches (app/services/feature_access.py): {code: bool}, a code that is absent is ON. Only what super admin
    # has granted can be on. Order types, bill options and back-office modules. Revision f2a4c6e8b0d3.
    feature_prefs: Mapped[dict] = mapped_column(JSONB, default=dict, server_default=text_("'{}'::jsonb"))
    # Kitchen lateness target: a kitchen ticket / open order older than this many minutes is shown as late (KDS, order
    # list colours). Owner setting, 5..120, default 15 (revision a7c2e9d4b1f3).
    kitchen_target_minutes: Mapped[int] = mapped_column(Integer, default=15, server_default="15")
    # Order rules (docs/ORDER_RULES.md, revision c4e8a1f7b2d9): a DINE-IN order cannot be billed until every item has gone to the
    # kitchen (409 kitchen_ticket_required; owners / managers may override with a reason). Takeaway / delivery never need it.
    require_kot_before_bill: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    # Kitchen status tracking (docs/KOT_ONLY_KITCHEN.md, revision d6f8b0c2e4a7): 'kot_only' (default, also for every existing
    # restaurant) = the kitchen just receives the ticket and taps Done; no Preparing / Ready / Served steps. 'track' = the full
    # workflow (new -> preparing -> ready -> served) with the waiter's "ready" notification. Switchable any time (PUT /restaurant).
    kitchen_status_mode: Mapped[str] = mapped_column(String(10), default="kot_only", server_default="kot_only")
    # KOT-only kitchen screen: nobody is there to click, so a ticket leaves the live list by itself this many minutes after it
    # arrived (and at end of day) and moves to "Earlier tickets" (nothing is deleted). Setting "Show tickets for N minutes", 5..120, default 20.
    kitchen_display_minutes: Mapped[int] = mapped_column(Integer, default=20, server_default="20")

    @property
    def tax_number_label(self) -> str:
        return "GSTIN"

    @property
    def tax_word(self) -> str:
        """GST, for every India restaurant (the engine mode does not change it): the word clients print for the tax."""
        from app.services.money import tax_word as _w  # local import: services import models
        return _w(self.tax_mode)

    @property
    def currency_symbol(self) -> str:
        return "\u20b9"


class Outlet(Base, TimestampMixin):
    """A physical location of a tenant (docs/OUTLETS.md). `restaurants` stays the tenant row; every restaurant has exactly one
    default outlet carrying the location-level settings. The tenant column is `restaurant_id` (like every tenant table) so
    the RLS policy, the tenancy guard and the composite foreign keys `(outlet_id, restaurant_id)` all use one name."""
    __tablename__ = "outlets"
    __table_args__ = (
        UniqueConstraint("restaurant_id", "code"),
        UniqueConstraint("id", "restaurant_id"),  # target of the composite FKs from the outlet-scoped tables
        Index("one_default_outlet", "restaurant_id", unique=True, postgresql_where=text_("is_default")),
        Index("uq_outlets_prefix", "restaurant_id", "invoice_prefix", unique=True, postgresql_where=text_("invoice_prefix <> ''")),
        # Only the default outlet may have an empty invoice prefix (its numbering must continue unchanged); others need one.
        CheckConstraint("is_default OR invoice_prefix <> ''", name="ck_outlets_prefix"),
        CheckConstraint(CK_INR, name="ck_outlets_currency_inr"),
        CheckConstraint(CK_IN, name="ck_outlets_country_in"),
    )
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    name: Mapped[str] = mapped_column(String(200))
    code: Mapped[str] = mapped_column(String(10))
    invoice_prefix: Mapped[str] = mapped_column(String(10), default="", server_default="")
    is_default: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    # Location-level settings, copied from the restaurant (the restaurant keeps its own copy until Phase 2).
    address: Mapped[str | None] = mapped_column(String(500))
    phone: Mapped[str | None] = mapped_column(String(30))
    trn: Mapped[str | None] = mapped_column(String(20))
    currency: Mapped[str] = mapped_column(String(3), default="INR", server_default="INR")  # always INR (CHECK)
    timezone: Mapped[str] = mapped_column(String(64), default="Asia/Kolkata", server_default="Asia/Kolkata")
    country: Mapped[str] = mapped_column(String(2), default="IN", server_default="IN")  # always IN (CHECK)
    prices_include_tax: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    vat_registered: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    service_charge_percent: Mapped[Decimal] = mapped_column(Numeric(5, 2), default=0, server_default="0")
    max_cashier_discount_percent: Mapped[Decimal] = mapped_column(Numeric(5, 2), default=10, server_default="10")
    z_report_next_number: Mapped[int] = mapped_column(Integer, default=1, server_default="1")
    auto_reorder_emails: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    reorder_email_window_hours: Mapped[int] = mapped_column(Integer, default=12, server_default="12")


class UserOutletAccess(Base):
    """Which outlets a non-owner / non-manager user may work in (docs/OUTLETS.md). Owners and managers always reach every outlet
    of their tenant. A user without rows reaches the default outlet only (what every existing user has today)."""
    __tablename__ = "user_outlet_access"
    __table_args__ = (
        ForeignKeyConstraint(["outlet_id", "restaurant_id"], ["outlets.id", "outlets.restaurant_id"], name="fk_user_outlet_access_outlet"),
    )
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    outlet_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class RoleDef(Base):
    """A role: the five system roles (restaurant_id NULL, shared, read-only for tenants) or a tenant's custom role. Named
    RoleDef because `Role` is the legacy enum. restaurant_id is the tenant column of the RLS policy (rls.PERMISSION_TABLES)."""
    __tablename__ = "roles"
    __table_args__ = (
        Index("uq_roles_system_key", "key", unique=True, postgresql_where=text_("restaurant_id IS NULL")),
        Index("uq_roles_tenant_key", "restaurant_id", "key", unique=True, postgresql_where=text_("restaurant_id IS NOT NULL")),
    )
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("restaurants.id"), index=True)
    key: Mapped[str] = mapped_column(String(60))
    name: Mapped[str] = mapped_column(String(100))
    is_system: Mapped[bool] = mapped_column(Boolean, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class RolePermission(Base):
    __tablename__ = "role_permissions"
    role_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("roles.id", ondelete="CASCADE"), primary_key=True)
    permission: Mapped[str] = mapped_column(String(60), primary_key=True)


class User(Base, TimestampMixin):
    __tablename__ = "users"
    __table_args__ = (UniqueConstraint("restaurant_id", "email"),
                      # Staff sign-in identifiers are unique per restaurant only (the restaurant code picks the tenant).
                      Index("uq_users_restaurant_phone", "restaurant_id", "phone", unique=True,
                            postgresql_where=text_("phone IS NOT NULL")),
                      Index("uq_users_restaurant_username", "restaurant_id", "username", unique=True,
                            postgresql_where=text_("username IS NOT NULL")),
                      CheckConstraint("email IS NOT NULL OR phone IS NOT NULL OR username IS NOT NULL",
                                      name="ck_users_has_identifier"))
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    # Optional for staff (waiters often have none): such a user signs in with the restaurant code + phone or username.
    email: Mapped[str | None] = mapped_column(String(255), index=True)
    phone: Mapped[str | None] = mapped_column(String(20))  # normalised, e.g. +919876543210 (services/staff_accounts.py)
    username: Mapped[str | None] = mapped_column(String(40))  # lower-case
    # Set when the password was generated for the user (one-time / temporary password): clients ask for a new one.
    must_change_password: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text_("false"))
    full_name: Mapped[str] = mapped_column(String(200))
    password_hash: Mapped[str] = mapped_column(String(255))
    role: Mapped[Role] = mapped_column(Enum(Role, name="role"))
    # A tenant's custom role overrides the permissions of the `role` enum when set (app/core/permissions.py); the enum stays
    # for the business rules that are not permissions (only owners create owners, the last owner cannot be demoted).
    custom_role_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("roles.id"), index=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    # Access tokens issued before this instant are refused (password change / reset, admin reset, deactivation): an access
    # token no longer survives them for its remaining lifetime (security review finding 11). The row is read per request
    # anyway, so this costs no extra query.
    sessions_valid_after: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Non-owners who opted in to the end of day report email (owners always get it while the restaurant setting is on).
    daily_report_opt_in: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")


class Device(Base, TimestampMixin):
    __tablename__ = "devices"
    __table_args__ = (UniqueConstraint("restaurant_id", "device_key"),)
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    outlet_id: Mapped[uuid.UUID] = outlet_col()
    device_key: Mapped[uuid.UUID] = mapped_column()  # client-generated, scoped per restaurant
    name: Mapped[str] = mapped_column(String(100), default="Chilli Agent device")
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    pending_ops: Mapped[int] = mapped_column(Integer, default=0)  # unsynced offline ops last reported


class TaxRate(Base, TimestampMixin):
    """Effective-dated tax rule. Never hardcode rates per item temperature."""
    __tablename__ = "tax_rates"
    __table_args__ = (UniqueConstraint("restaurant_id", "code", "effective_from"),)
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    code: Mapped[str] = mapped_column(String(20), default="standard", server_default="standard")  # standard | zero
    name: Mapped[str] = mapped_column(String(50))  # e.g. "GST"
    rate_percent: Mapped[Decimal] = mapped_column(Numeric(5, 2))
    effective_from: Mapped[date] = mapped_column(Date)
    effective_to: Mapped[date | None] = mapped_column(Date)


class Category(Base, TimestampMixin):
    __tablename__ = "menu_categories"
    __table_args__ = (UniqueConstraint("restaurant_id", "name"),)
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    name: Mapped[str] = mapped_column(String(100))
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)


#: FSSAI food mark of a dish (the green / brown square, plus egg as Indian menus print it). A closed list, because a guest
#: asking "is this veg" needs a definite answer; NULL = not marked (the UI draws no mark, never guesses one).
FOOD_TYPES = ("veg", "non_veg", "egg")
MENU_DESCRIPTION_MAX = 280


class MenuItem(Base, TimestampMixin):
    __tablename__ = "menu_items"
    __table_args__ = (
        CheckConstraint("food_type IS NULL OR food_type IN ('veg', 'non_veg', 'egg')", name="ck_menu_items_food_type"),
        CheckConstraint(f"description IS NULL OR char_length(description) <= {MENU_DESCRIPTION_MAX}",
                        name="ck_menu_items_description_len"),
    )
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    category_id: Mapped[uuid.UUID] = fk("menu_categories")
    name: Mapped[str] = mapped_column(String(200))
    # Menu price: tax-exclusive when restaurants.prices_include_tax is false, tax-inclusive when true.
    price: Mapped[Decimal] = mapped_column(MONEY)
    # hot_food | cold_food | standard: a stored label only, kept for API compatibility. It has no tax effect (India: every
    # line of a registered seller is 'standard'; HSN / supply type / gst_rate_code drive the GST engine).
    tax_kind: Mapped[str] = mapped_column(String(12), default="standard", server_default="standard")
    # India GST (only read when the restaurant's tax_mode is 'gst_engine'): HSN/SAC (null = the configured restaurant SAC for
    # restaurant-type items), supply type restaurant | goods | other, and the rate code goods/other items must carry.
    hsn: Mapped[str | None] = mapped_column(String(8))
    supply_type: Mapped[str] = mapped_column(String(12), default="restaurant", server_default="restaurant")
    gst_rate_code: Mapped[str | None] = mapped_column(String(20))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    # Menu metadata (docs/MENU_META.md): FOOD_TYPES or NULL (unmarked), and a one-line description (<= 280 chars) for the
    # dish card / online menu. Neither is printed on KOTs or bills, nor used in pricing or tax.
    food_type: Mapped[str | None] = mapped_column(String(8), nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Photo: server-generated WebP file names under <storage_dir>/<restaurant_id>/menu/ (see services/menu_images.py).
    image_key: Mapped[str | None] = mapped_column(String(64), nullable=True)
    thumb_key: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # "Sold out today" (86): the restaurant-local date the dish is sold out for. Any other day it is available again, so the
    # switch resets itself at midnight (restaurant timezone) without a job. Null = available (docs/ORDER_RULES.md).
    sold_out_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    variants: Mapped[list["MenuVariant"]] = relationship(back_populates="item", cascade="all, delete-orphan")

    @property
    def image_url(self) -> str | None:
        return f"{MENU_MEDIA_PREFIX}/{self.restaurant_id}/{self.image_key}" if self.image_key else None

    @property
    def thumb_url(self) -> str | None:
        return f"{MENU_MEDIA_PREFIX}/{self.restaurant_id}/{self.thumb_key}" if self.thumb_key else None


class MenuVariant(Base):
    __tablename__ = "menu_variants"
    id: Mapped[uuid.UUID] = uuid_pk()
    item_id: Mapped[uuid.UUID] = fk("menu_items")
    name: Mapped[str] = mapped_column(String(100))
    price_delta: Mapped[Decimal] = mapped_column(MONEY, default=0)
    # Removed variants are deactivated, never deleted: order_lines.variant_id keeps pointing at them.
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    # The option used when an order line names none (docs/ORDER_RULES.md: Half of Half/Full). At most one per item.
    is_default: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    item: Mapped[MenuItem] = relationship(back_populates="variants")


class DiningTable(Base, TimestampMixin):
    __tablename__ = "dining_tables"
    __table_args__ = (UniqueConstraint("outlet_id", "label"),)  # labels are per outlet (T1 may exist in every outlet)
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    outlet_id: Mapped[uuid.UUID] = outlet_col()
    label: Mapped[str] = mapped_column(String(50))
    seats: Mapped[int] = mapped_column(Integer, default=4)
    area: Mapped[OrderType] = mapped_column(Enum(OrderType, name="order_type"), default=OrderType.indoor)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")


class Order(Base, TimestampMixin):
    __tablename__ = "orders"
    __table_args__ = (UniqueConstraint("restaurant_id", "client_uuid"),
                      Index("ix_orders_rest_outlet_created", "restaurant_id", "outlet_id", "created_at"),
                      # one-open-order-per-table check and tables/status (revision e9b1d3f5a7c2): only the rows that are open now
                      Index("ix_orders_open_by_table", "table_id", postgresql_where=text_("status IN ('open', 'sent_to_kitchen')")),
                      Index("uq_orders_token", "outlet_id", "token_date", "token_number", unique=True,
                            postgresql_where=text_("token_number IS NOT NULL")))
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    outlet_id: Mapped[uuid.UUID] = outlet_col()
    client_uuid: Mapped[uuid.UUID] = mapped_column(index=True)  # idempotency / offline UUID
    order_type: Mapped[OrderType] = mapped_column(Enum(OrderType, name="order_type"))
    table_id: Mapped[uuid.UUID | None] = fk("dining_tables", nullable=True)
    status: Mapped[OrderStatus] = mapped_column(Enum(OrderStatus, name="order_status"), default=OrderStatus.open)
    created_by: Mapped[uuid.UUID] = fk("users")
    customer_id: Mapped[uuid.UUID | None] = fk("customers", nullable=True)
    cancel_reason: Mapped[str | None] = mapped_column(String(300))
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    cancelled_by: Mapped[uuid.UUID | None] = fk("users", nullable=True)
    # Waiter app (docs/WAITER_API.md): the per outlet per day token (gap-free counter "TOK", day = outlet-local date), a
    # free-text order note, the "bring the bill" request (cleared when the bill is finalized) and the merge marker.
    token_number: Mapped[int | None] = mapped_column(Integer)
    token_date: Mapped[date | None] = mapped_column(Date)
    note: Mapped[str | None] = mapped_column(String(300))
    bill_requested_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    bill_requested_by: Mapped[uuid.UUID | None] = fk("users", nullable=True)
    merged_into_order_id: Mapped[uuid.UUID | None] = fk("orders", nullable=True)
    lines: Mapped[list["OrderLine"]] = relationship(
        back_populates="order", cascade="all, delete-orphan", order_by="OrderLine.position")


class Shift(Base):
    """A user's working shift at an outlet (waiter / cashier / ...). At most one OPEN shift per (user, outlet), enforced by a
    partial unique index. Closed by the user, by a manager, or automatically by the Z report (end of day) of the outlet."""
    __tablename__ = "shifts"
    __table_args__ = (Index("uq_shifts_one_open", "user_id", "outlet_id", unique=True, postgresql_where=text_("closed_at IS NULL")),)
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    outlet_id: Mapped[uuid.UUID] = outlet_col()
    user_id: Mapped[uuid.UUID] = fk("users")
    role: Mapped[str] = mapped_column(String(20))  # the user's role when the shift opened (snapshot)
    opened_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    open_note: Mapped[str | None] = mapped_column(String(300))
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    closed_by: Mapped[uuid.UUID | None] = fk("users", nullable=True)
    close_reason: Mapped[str | None] = mapped_column(String(20))  # self | manager | day_close
    tables: Mapped[list["TableAssignment"]] = relationship(cascade="all, delete-orphan", lazy="selectin")


class TableAssignment(Base):
    """A table assigned to the user of a shift (by a manager). Replaced as a set; ends with the shift."""
    __tablename__ = "table_assignments"
    __table_args__ = (UniqueConstraint("shift_id", "table_id"),)
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    outlet_id: Mapped[uuid.UUID] = outlet_col()
    shift_id: Mapped[uuid.UUID] = fk("shifts")
    table_id: Mapped[uuid.UUID] = fk("dining_tables")
    user_id: Mapped[uuid.UUID] = fk("users")
    assigned_by: Mapped[uuid.UUID] = fk("users")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class OrderLine(Base):
    __tablename__ = "order_lines"
    id: Mapped[uuid.UUID] = uuid_pk()
    order_id: Mapped[uuid.UUID] = fk("orders")
    item_id: Mapped[uuid.UUID] = fk("menu_items")
    variant_id: Mapped[uuid.UUID | None] = fk("menu_variants", nullable=True)
    item_name: Mapped[str] = mapped_column(String(200))  # snapshot
    unit_price: Mapped[Decimal] = mapped_column(MONEY)  # server-computed snapshot
    quantity: Mapped[int] = mapped_column(Integer)
    note: Mapped[str | None] = mapped_column(String(300))
    # Stable order of the lines inside the order (0..n-1): send_kot slices order.lines by it, add-on lines go last.
    position: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    batch_uuid: Mapped[uuid.UUID | None] = mapped_column(index=True)  # idempotency key of an "add lines" request
    # Snapshots (docs/MODIFIERS_OFFERS.md), NULL on plain lines: chosen modifier options
    # [{group_id, group, option_id, name, price_delta_paise}] (already included in unit_price) and, for a combo item, its
    # components [{item_id, item, variant_id, qty}] (per one combo) for the kitchen ticket.
    modifiers: Mapped[list | None] = mapped_column(JSON(none_as_null=True))
    components: Mapped[list | None] = mapped_column(JSON(none_as_null=True))
    order: Mapped[Order] = relationship(back_populates="lines")


class Kot(Base, TimestampMixin):
    __tablename__ = "kot_tickets"
    __table_args__ = (UniqueConstraint("outlet_id", "number"),)  # KOT numbers are per outlet
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    outlet_id: Mapped[uuid.UUID] = outlet_col()
    order_id: Mapped[uuid.UUID] = fk("orders")
    number: Mapped[int] = mapped_column(Integer)
    status: Mapped[KotStatus] = mapped_column(Enum(KotStatus, name="kot_status"), default=KotStatus.pending)
    payload: Mapped[list] = mapped_column(JSON)  # snapshot of lines sent
    # The single "kitchen is done with this ticket" flag (KOT-only mode: the Done button; also set when the status becomes
    # served). The ticket's status becomes `served` with it, so every consumer that already knows "finished" keeps working.
    done_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class AuditLog(Base):
    __tablename__ = "audit_logs"
    __table_args__ = (Index("ix_audit_logs_restaurant_created", "restaurant_id", "created_at"),)
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    user_id: Mapped[uuid.UUID | None] = fk("users", nullable=True)
    action: Mapped[str] = mapped_column(String(100))
    entity: Mapped[str] = mapped_column(String(100))
    entity_id: Mapped[str | None] = mapped_column(String(64))
    detail: Mapped[dict | None] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class PaymentMethod(str, enum.Enum):
    cash = "cash"
    card = "card"
    upi = "upi"
    other = "other"
    credit_note = "credit_note"  # settles a replacement bill from the superseded original's payments (not cash-in)


class InvoiceSequence(Base):
    """Gap-free per-restaurant counters; row-locked on increment."""
    __tablename__ = "invoice_sequences"
    __table_args__ = (UniqueConstraint("outlet_id", "kind", "year"),)  # one counter per outlet / kind / year
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    outlet_id: Mapped[uuid.UUID] = outlet_col()
    kind: Mapped[str] = mapped_column(String(10))  # INV / CN / KOT (KOT uses year=0: never resets)
    year: Mapped[int] = mapped_column(Integer)
    last_number: Mapped[int] = mapped_column(Integer, default=0)


class Bill(Base):
    """Finalized tax invoice. Immutable snapshot; corrections go through refunds/credit notes."""
    __tablename__ = "bills"
    __table_args__ = (
        UniqueConstraint("restaurant_id", "invoice_number"),
        # One ORIGINAL bill per order; amendment replacements (amends_bill_id set) share the order.
        Index("uq_bills_order_original", "order_id", unique=True, postgresql_where=text_("amends_bill_id IS NULL")),
        Index("ix_bills_restaurant_finalized", "restaurant_id", "finalized_at"),
        Index("ix_bills_restaurant_sale", "restaurant_id", "sale_at"),
        Index("ix_bills_rest_outlet_sale", "restaurant_id", "outlet_id", "sale_at"),  # outlet-scoped reports
        CheckConstraint(CK_INR, name="ck_bills_currency_inr"),
        CheckConstraint(CK_IN, name="ck_bills_country_in"),
    )
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    outlet_id: Mapped[uuid.UUID] = outlet_col()
    order_id: Mapped[uuid.UUID] = fk("orders")
    invoice_number: Mapped[str] = mapped_column(String(30))
    seller_name: Mapped[str] = mapped_column(String(200))
    seller_trn: Mapped[str | None] = mapped_column(String(20))
    seller_address: Mapped[str | None] = mapped_column(String(500))
    seller_phone: Mapped[str | None] = mapped_column(String(30))
    currency: Mapped[str] = mapped_column(String(3))
    tax_name: Mapped[str] = mapped_column(String(50))
    tax_rate_percent: Mapped[Decimal] = mapped_column(Numeric(5, 2))
    subtotal: Mapped[Decimal] = mapped_column(MONEY)
    tax_amount: Mapped[Decimal] = mapped_column(MONEY)
    total: Mapped[Decimal] = mapped_column(MONEY)
    finalized_by: Mapped[uuid.UUID] = fk("users")
    # finalized_at = when the record was POSTED (till X/Z periods use it); sale_at = the sale's own date/time (date
    # reports and the document date use it). They are equal except for amendment replacements, which inherit the
    # ORIGINAL sale_at.
    finalized_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    sale_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    # Amendment chain. The original row is never modified except these two link columns.
    status: Mapped[str] = mapped_column(String(12), default="active", server_default="active")  # active | superseded | voided
    superseded_by_bill_id: Mapped[uuid.UUID | None] = fk("bills", nullable=True)
    amends_bill_id: Mapped[uuid.UUID | None] = fk("bills", nullable=True)
    amended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    amended_by: Mapped[uuid.UUID | None] = fk("users", nullable=True)
    amend_reason: Mapped[str | None] = mapped_column(String(300))
    # Whole-bill void (services/void.py): status 'voided', credit note kind 'void'. Never set on other rows.
    voided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    voided_by: Mapped[uuid.UUID | None] = fk("users", nullable=True)
    void_reason: Mapped[str | None] = mapped_column(String(300))
    # Print snapshots (nullable: bills finalized before these existed fall back to live lookups when rendered)
    customer_name: Mapped[str | None] = mapped_column(String(200))
    customer_phone: Mapped[str | None] = mapped_column(String(20))
    table_label: Mapped[str | None] = mapped_column(String(50))
    # Public receipt links (services/receipt_links.py) carry this counter; revoking the links bumps it (security review 9).
    receipt_link_gen: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    order_type: Mapped[str | None] = mapped_column(String(20))
    cashier_name: Mapped[str | None] = mapped_column(String(200))
    # Tax snapshot (see app/services/tax.py).
    country: Mapped[str] = mapped_column(String(2), default="IN", server_default="IN")  # always IN (CHECK)
    prices_include_tax: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    vat_registered: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    discount_amount: Mapped[Decimal] = mapped_column(MONEY, default=0, server_default="0")
    discount_reason: Mapped[str | None] = mapped_column(String(200))
    service_charge_amount: Mapped[Decimal] = mapped_column(MONEY, default=0, server_default="0")
    service_charge_percent: Mapped[Decimal] = mapped_column(Numeric(5, 2), default=0, server_default="0")
    tax_breakdown: Mapped[list | None] = mapped_column(JSON(none_as_null=True))  # [{code, rate_percent, net, vat, gross}] (`vat` = the row's tax), null on old bills
    # India GST snapshot (tax_mode 'gst_engine' only; zero/null otherwise). total = subtotal + tax_amount + round_off.
    tax_mode: Mapped[str] = mapped_column(String(12), default="off", server_default="off")
    document_type: Mapped[str] = mapped_column(String(16), default="tax_invoice", server_default="tax_invoice")
    seller_gstin: Mapped[str | None] = mapped_column(String(15))
    customer_gstin: Mapped[str | None] = mapped_column(String(15))
    customer_state_code: Mapped[str | None] = mapped_column(String(2))
    place_of_supply: Mapped[str | None] = mapped_column(String(2))
    cgst_amount: Mapped[Decimal] = mapped_column(MONEY, default=0, server_default="0")
    sgst_amount: Mapped[Decimal] = mapped_column(MONEY, default=0, server_default="0")
    igst_amount: Mapped[Decimal] = mapped_column(MONEY, default=0, server_default="0")
    round_off: Mapped[Decimal] = mapped_column(MONEY, default=0, server_default="0")
    packaging_amount: Mapped[Decimal] = mapped_column(MONEY, default=0, server_default="0")
    delivery_amount: Mapped[Decimal] = mapped_column(MONEY, default=0, server_default="0")
    gst_document: Mapped[dict | None] = mapped_column(JSON(none_as_null=True))  # engine Invoice.to_dict(): credit notes replay from it
    # Automatic offers (docs/MODIFIERS_OFFERS.md). offer_amount is PART of discount_amount (which stays the bill's total
    # discount, so reports and reconciliation are unchanged); offers = {"applied": [{offer_id, name, label, amount}],
    # "manual_amount", "manual_reason"} so receipts print one 'Offer: <name>' line per offer plus the manual discount.
    offer_amount: Mapped[Decimal] = mapped_column(MONEY, default=0, server_default="0")
    offers: Mapped[dict | None] = mapped_column(JSON(none_as_null=True))
    lines: Mapped[list["BillLine"]] = relationship(cascade="all, delete-orphan", order_by="BillLine.position")
    payments: Mapped[list["Payment"]] = relationship(back_populates="bill")
    refunds: Mapped[list["Refund"]] = relationship(back_populates="bill", foreign_keys="Refund.bill_id")


class BillLine(Base):
    __tablename__ = "bill_lines"
    id: Mapped[uuid.UUID] = uuid_pk()
    bill_id: Mapped[uuid.UUID] = fk("bills")
    position: Mapped[int] = mapped_column(Integer)
    description: Mapped[str] = mapped_column(String(200))
    quantity: Mapped[int] = mapped_column(Integer)
    unit_price: Mapped[Decimal] = mapped_column(MONEY)
    # Amount shown on the receipt line BEFORE any bill discount: gross when the bill's prices include tax, else net.
    line_total: Mapped[Decimal] = mapped_column(MONEY)
    # Tax snapshot, AFTER the line's share of the discount. Null on old rows (then net = line_total, vat from the bill).
    item_id: Mapped[uuid.UUID | None] = fk("menu_items", nullable=True)  # menu item snapshot (reports / recipe mapping)
    category_name: Mapped[str | None] = mapped_column(String(100))  # category at sale time (Z-report); null on old rows
    tax_code: Mapped[str | None] = mapped_column(String(20))
    tax_rate_percent: Mapped[Decimal | None] = mapped_column(Numeric(5, 2))
    net_amount: Mapped[Decimal | None] = mapped_column(MONEY)
    vat_amount: Mapped[Decimal | None] = mapped_column(MONEY)
    gross_amount: Mapped[Decimal | None] = mapped_column(MONEY)
    hsn: Mapped[str | None] = mapped_column(String(8))  # India GST: HSN/SAC snapshot
    cgst_amount: Mapped[Decimal | None] = mapped_column(MONEY)
    sgst_amount: Mapped[Decimal | None] = mapped_column(MONEY)
    igst_amount: Mapped[Decimal | None] = mapped_column(MONEY)
    modifiers: Mapped[list | None] = mapped_column(JSON(none_as_null=True))  # snapshot of the order line's modifiers


class Payment(Base):
    __tablename__ = "payments"
    __table_args__ = (UniqueConstraint("restaurant_id", "idempotency_key"),
                      Index("ix_payments_rest_outlet_created", "restaurant_id", "outlet_id", "created_at"))
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    outlet_id: Mapped[uuid.UUID] = outlet_col()
    bill_id: Mapped[uuid.UUID] = fk("bills")
    idempotency_key: Mapped[uuid.UUID] = mapped_column()
    method: Mapped[PaymentMethod] = mapped_column(Enum(PaymentMethod, name="payment_method"))
    amount: Mapped[Decimal] = mapped_column(MONEY)
    created_by: Mapped[uuid.UUID] = fk("users")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    bill: Mapped[Bill] = relationship(back_populates="payments")


class PaymentProviderAccount(Base):
    """A restaurant's payment-provider account as registered in payments-service. Holds env var NAMES (secret references in
    payments-service's namespace PAY_SECRET_<TENANT>__<NAME>), never a secret value."""
    __tablename__ = "payment_provider_accounts"
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    provider: Mapped[str] = mapped_column(String(20))
    remote_account_id: Mapped[uuid.UUID] = mapped_column()  # provider_accounts.id in payments-service
    key_id_ref: Mapped[str] = mapped_column(String(80))
    key_secret_ref: Mapped[str] = mapped_column(String(80))
    webhook_secret_ref: Mapped[str] = mapped_column(String(80))
    active: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    created_by: Mapped[uuid.UUID] = fk("users")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class OnlinePayment(Base):
    """One attempt to collect (part of) a bill through payments-service. The bill's own `payments` row is created ONLY when
    payments-service reports captured money (services/online_payments.py); `captured_amount` is what it reported, split into
    `applied_amount` (recorded against the bill) and `unallocated_amount` (money received beyond what the bill still owed)."""
    __tablename__ = "online_payments"
    __table_args__ = (UniqueConstraint("restaurant_id", "idempotency_key"),
                      CheckConstraint(CK_INR, name="ck_online_payments_currency_inr"))
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    outlet_id: Mapped[uuid.UUID] = outlet_col()
    bill_id: Mapped[uuid.UUID] = fk("bills")
    idempotency_key: Mapped[uuid.UUID] = mapped_column()  # the client's key; payments-service's key is derived from it
    method: Mapped[str] = mapped_column(String(20))  # upi_qr | payment_link
    amount: Mapped[Decimal] = mapped_column(MONEY)
    currency: Mapped[str] = mapped_column(String(3))
    description: Mapped[str] = mapped_column(String(200), default="", server_default="")
    provider_account_id: Mapped[uuid.UUID] = mapped_column()  # remote account the intent was created under
    # creating = request stored, payments-service not (known to be) reached; then payments-service's own statuses.
    status: Mapped[str] = mapped_column(String(20), default="creating", server_default="creating")
    remote_intent_id: Mapped[uuid.UUID | None] = mapped_column(nullable=True)
    payment_url: Mapped[str | None] = mapped_column(String(1000))
    qr_payload: Mapped[str | None] = mapped_column(String(2000))
    captured_amount: Mapped[Decimal] = mapped_column(MONEY, default=0, server_default="0")
    applied_amount: Mapped[Decimal] = mapped_column(MONEY, default=0, server_default="0")
    unallocated_amount: Mapped[Decimal] = mapped_column(MONEY, default=0, server_default="0")
    last_error: Mapped[str | None] = mapped_column(String(300))
    last_synced_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_by: Mapped[uuid.UUID] = fk("users")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Refund(Base):
    """Refund with credit note. Tax portion is derived from the bill's snapshot rate."""
    __tablename__ = "refunds"
    __table_args__ = (UniqueConstraint("restaurant_id", "idempotency_key"),
                      UniqueConstraint("restaurant_id", "credit_note_number"),
                      Index("ix_refunds_rest_outlet_created", "restaurant_id", "outlet_id", "created_at"))
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    outlet_id: Mapped[uuid.UUID] = outlet_col()
    bill_id: Mapped[uuid.UUID] = fk("bills")
    idempotency_key: Mapped[uuid.UUID] = mapped_column()
    credit_note_number: Mapped[str] = mapped_column(String(30))
    amount: Mapped[Decimal] = mapped_column(MONEY)  # tax-inclusive
    tax_amount: Mapped[Decimal] = mapped_column(MONEY)
    reason: Mapped[str] = mapped_column(String(300))
    created_by: Mapped[uuid.UUID] = fk("users")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    # refund = a normal partial/full refund; amendment = the full reversal credit note of an amended bill (NOT a
    # return: Z reports show it under CORRECTIONS); void = the full credit note of a voided bill (no replacement; the
    # money paid is returned by hand and recorded as negative payments + payout_amount). payout_* = money handed back to the customer at the amendment.
    kind: Mapped[str] = mapped_column(String(12), default="refund", server_default="refund")
    payout_amount: Mapped[Decimal] = mapped_column(MONEY, default=0, server_default="0")
    payout_method: Mapped[str | None] = mapped_column(String(10))
    replacement_bill_id: Mapped[uuid.UUID | None] = fk("bills", nullable=True)
    # India GST: signed round-off share of this credit note (amount = taxable + tax + round_off) and the serialised engine
    # CreditNote (to_dict) that later partial credits replay against.
    round_off: Mapped[Decimal] = mapped_column(MONEY, default=0, server_default="0")
    credit_note_doc: Mapped[dict | None] = mapped_column(JSON(none_as_null=True))
    bill: Mapped[Bill] = relationship(back_populates="refunds", foreign_keys=[bill_id])


class CashSession(Base):
    """A cashier's shift at one outlet (docs/CASH_SESSIONS.md): opening float, then counted cash at close. expected_cash,
    variance and the cash breakdown are snapshots taken when the session is closed."""
    __tablename__ = "cash_sessions"
    __table_args__ = (
        Index("uq_cash_sessions_one_open", "outlet_id", "cashier_id", unique=True, postgresql_where=text_("status = 'open'")),
        Index("ix_cash_sessions_restaurant_opened", "restaurant_id", "opened_at"),
    )
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    outlet_id: Mapped[uuid.UUID] = outlet_col()
    cashier_id: Mapped[uuid.UUID] = fk("users")
    status: Mapped[str] = mapped_column(String(10), default="open", server_default="open")  # open | closed
    opened_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    opening_float: Mapped[Decimal] = mapped_column(MONEY, default=0, server_default="0")
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    closed_by: Mapped[uuid.UUID | None] = fk("users", nullable=True)
    counted_cash: Mapped[Decimal | None] = mapped_column(MONEY)
    expected_cash: Mapped[Decimal | None] = mapped_column(MONEY)
    variance: Mapped[Decimal | None] = mapped_column(MONEY)  # counted - expected
    variance_reason: Mapped[str | None] = mapped_column(String(300))
    breakdown: Mapped[dict | None] = mapped_column(JSON)
    idempotency_key: Mapped[uuid.UUID | None] = mapped_column(nullable=True)


class ZReport(Base):
    """End-of-day closing report. Immutable snapshot: `data` is the full report (all numbers as strings). Periods of
    one restaurant are contiguous ([period_from, period_to) of Z n+1 starts where Z n ended)."""
    __tablename__ = "z_reports"
    __table_args__ = (UniqueConstraint("outlet_id", "number"),  # Z numbers are per outlet
                      UniqueConstraint("restaurant_id", "idempotency_key"))
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    outlet_id: Mapped[uuid.UUID] = outlet_col()
    number: Mapped[int] = mapped_column(Integer)
    period_from: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    period_to: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    closed_by: Mapped[uuid.UUID] = fk("users")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    data: Mapped[dict] = mapped_column(JSON)
    idempotency_key: Mapped[uuid.UUID] = mapped_column()


class MovementType(str, enum.Enum):
    purchase = "purchase"
    sale = "sale"
    adjustment = "adjustment"
    wastage = "wastage"
    count = "count"
    purchase_return = "purchase_return"  # goods sent back to the supplier (negative)
    expiry_writeoff = "expiry_writeoff"  # an expired batch written off (negative)


class PurchaseStatus(str, enum.Enum):
    uploaded = "uploaded"
    extracted = "extracted"
    failed = "failed"
    confirmed = "confirmed"


class InventoryItem(Base, TimestampMixin):
    __tablename__ = "inventory_items"
    __table_args__ = (UniqueConstraint("restaurant_id", "name"),
                      Index("uq_inventory_items_sku", "restaurant_id", "sku", unique=True, postgresql_where=text_("sku IS NOT NULL")))
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    name: Mapped[str] = mapped_column(String(200))
    base_unit: Mapped[str] = mapped_column(String(10))  # g | ml | pcs
    reorder_level: Mapped[Decimal] = mapped_column(QTY, default=0)  # in base unit
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    # "Usual supplier": set by a confirmed purchase unless the owner chose one (supplier_manual); who gets the re-order email.
    supplier_id: Mapped[uuid.UUID | None] = fk("suppliers", nullable=True)
    supplier_manual: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    reorder_quantity: Mapped[Decimal | None] = mapped_column(QTY, nullable=True)  # how much to ask for, in the base unit
    sku: Mapped[str | None] = mapped_column(String(60))  # barcode / SKU, unique per restaurant when present
    category: Mapped[str | None] = mapped_column(String(60))
    tracks_batches: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")  # batch + expiry, FEFO
    shelf_life_days: Mapped[int | None] = mapped_column(Integer)
    # Latest purchase cost per base unit (set by every `purchase` posting that carries a cost): the food-cost basis.
    last_cost: Mapped[Decimal | None] = mapped_column(Numeric(12, 4))
    # Running total of the ledger, kept by a database trigger on stock_movements (app/core/stock_db.py). Never written by code.
    balance: Mapped[Decimal] = mapped_column(Numeric(14, 3), default=0, server_default="0")


class StockMovement(Base):
    """Append-only ledger (UPDATE / DELETE are refused by a trigger). Balance = SUM(quantity), also kept per item, per location
    and per batch by the same trigger. The unique index makes postings idempotent per (item, type, ref, location, batch)."""
    __tablename__ = "stock_movements"
    __table_args__ = (
        Index("uq_stock_movements_ref", "restaurant_id", "item_id", "movement_type", "ref_id", "location_id",
              text_("coalesce(batch_id, '00000000-0000-0000-0000-000000000000'::uuid)"), unique=True),
    )
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    item_id: Mapped[uuid.UUID] = fk("inventory_items")
    movement_type: Mapped[MovementType] = mapped_column(Enum(MovementType, name="movement_type"))
    quantity: Mapped[Decimal] = mapped_column(Numeric(14, 3))  # signed, base unit
    unit_cost: Mapped[Decimal | None] = mapped_column(Numeric(12, 4))  # per base unit
    ref_id: Mapped[uuid.UUID | None] = mapped_column()  # bill / purchase invoice / count batch
    detail: Mapped[dict | None] = mapped_column(JSON)
    note: Mapped[str | None] = mapped_column(String(300))
    created_by: Mapped[uuid.UUID | None] = fk("users", nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)
    location_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("stock_locations.id"), index=True)
    batch_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("stock_batches.id"), index=True)
    reason_code: Mapped[str | None] = mapped_column(String(20))  # wastage / adjustment reason (services/stock.REASONS)
    ref_type: Mapped[str | None] = mapped_column(String(20))  # what ref_id points at: bill | grn_line | return_line | count_line ...


class Recipe(Base):
    """One row per version. Only one version per menu item has effective_to IS NULL."""
    __tablename__ = "recipes"
    __table_args__ = (UniqueConstraint("menu_item_id", "version"),)
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    menu_item_id: Mapped[uuid.UUID] = fk("menu_items")
    version: Mapped[int] = mapped_column(Integer)
    effective_from: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    effective_to: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    ingredients: Mapped[list["RecipeIngredient"]] = relationship(cascade="all, delete-orphan")


class RecipeIngredient(Base):
    __tablename__ = "recipe_ingredients"
    id: Mapped[uuid.UUID] = uuid_pk()
    recipe_id: Mapped[uuid.UUID] = fk("recipes")
    item_id: Mapped[uuid.UUID] = fk("inventory_items")
    quantity: Mapped[Decimal] = mapped_column(Numeric(14, 3))  # base unit per 1 portion


class Supplier(Base, TimestampMixin):
    __tablename__ = "suppliers"
    __table_args__ = (UniqueConstraint("restaurant_id", "name"),)
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    name: Mapped[str] = mapped_column(String(200))
    trn: Mapped[str | None] = mapped_column(String(20))
    phone: Mapped[str | None] = mapped_column(String(30))
    email: Mapped[str | None] = mapped_column(String(254))
    contact_name: Mapped[str | None] = mapped_column(String(120))
    auto_reorder: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")  # automatic re-order emails
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")


class SupplierEmail(Base, TimestampMixin):
    """Every re-order email (automatic or manual) with its outcome: the history list and the idempotency record."""
    __tablename__ = "supplier_emails"
    __table_args__ = (UniqueConstraint("dedupe_key"),)
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    supplier_id: Mapped[uuid.UUID] = fk("suppliers")
    to_email: Mapped[str] = mapped_column(String(254))
    subject: Mapped[str] = mapped_column(String(300))
    body_text: Mapped[str] = mapped_column(Text)
    body_html: Mapped[str | None] = mapped_column(Text)
    items: Mapped[list] = mapped_column(JSONB, default=list)  # [{item_id, name, unit, balance, quantity}] (base units)
    note: Mapped[str | None] = mapped_column(String(500))
    kind: Mapped[str] = mapped_column(String(10))  # auto | manual
    status: Mapped[str] = mapped_column(String(10), default="queued")  # queued | sent | failed
    error: Mapped[str | None] = mapped_column(String(500))
    attempts: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_by: Mapped[uuid.UUID | None] = fk("users", nullable=True)
    dedupe_key: Mapped[str | None] = mapped_column(String(100))  # auto emails: unique per claimed set of alerts


class PurchaseInvoice(Base, TimestampMixin):
    __tablename__ = "purchase_invoices"
    __table_args__ = (UniqueConstraint("restaurant_id", "file_sha256"),)
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    supplier_id: Mapped[uuid.UUID | None] = fk("suppliers", nullable=True)
    status: Mapped[PurchaseStatus] = mapped_column(Enum(PurchaseStatus, name="purchase_status"),
                                                   default=PurchaseStatus.uploaded)
    file_path: Mapped[str] = mapped_column(String(500))
    content_type: Mapped[str] = mapped_column(String(100))
    file_sha256: Mapped[str] = mapped_column(String(64))
    invoice_number: Mapped[str | None] = mapped_column(String(100))
    invoice_date: Mapped[date | None] = mapped_column(Date)
    total: Mapped[Decimal | None] = mapped_column(MONEY)
    extracted_json: Mapped[dict | None] = mapped_column(JSON)  # raw OCR output, kept for audit
    # Footer totals as printed: net + vat = gross (= total). `vat` holds the invoice's GST / input tax (column name kept for
    # API compatibility).
    net: Mapped[Decimal | None] = mapped_column(MONEY)
    vat: Mapped[Decimal | None] = mapped_column(MONEY)
    supplier_name_raw: Mapped[str | None] = mapped_column(String(200))  # what the invoice says, when no saved supplier matched
    supplier_vat_number: Mapped[str | None] = mapped_column(String(30))
    document_type: Mapped[str] = mapped_column(String(20), default="stock_purchase", server_default="stock_purchase")  # stock_purchase | expense | other
    confidence: Mapped[Decimal | None] = mapped_column(Numeric(4, 3))
    error: Mapped[str | None] = mapped_column(String(500))
    confirmed_by: Mapped[uuid.UUID | None] = fk("users", nullable=True)
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    lines: Mapped[list["PurchaseLine"]] = relationship(cascade="all, delete-orphan", order_by="PurchaseLine.position")

    @property
    def bill(self) -> dict | None:
        """Printed header / tax rows / currency (INR or null) of the scanned bill (see services.purchases.bill_view)."""
        from app.services.purchases import bill_view  # local import: services import models
        return bill_view(self.extracted_json)

    @property
    def currency_warning(self) -> dict | None:
        """{code: not_inr, message} while the bill read is in another currency (services.purchases.NOT_INR_CODE)."""
        from app.services.purchases import currency_warning  # local import: services import models
        return currency_warning(self.extracted_json)

    @property
    def retry_extraction_allowed(self) -> bool:
        """Failed, or still `uploaded` long after its last claim (the background job was lost, e.g. API restart)."""
        from app.services.purchases import is_stale  # local import: services import models
        return self.status == PurchaseStatus.failed or (self.status == PurchaseStatus.uploaded and is_stale(self))


class PurchaseLine(Base):
    __tablename__ = "purchase_lines"
    id: Mapped[uuid.UUID] = uuid_pk()
    invoice_id: Mapped[uuid.UUID] = fk("purchase_invoices")
    position: Mapped[int] = mapped_column(Integer)
    description: Mapped[str] = mapped_column(String(300))
    item_id: Mapped[uuid.UUID | None] = fk("inventory_items", nullable=True)
    quantity: Mapped[Decimal] = mapped_column(Numeric(14, 3))
    unit: Mapped[str] = mapped_column(String(20))
    unit_price: Mapped[Decimal] = mapped_column(Numeric(12, 4))
    line_total: Mapped[Decimal] = mapped_column(MONEY)
    confidence: Mapped[Decimal | None] = mapped_column(Numeric(4, 3))
    # How the stock quantity was worked out (see services/packs.py) and what is still unverified.
    pack: Mapped[dict | None] = mapped_column(JSON)  # {invoiced:{quantity,unit,unit_price}, text, count_total, measure, options, ...}
    needs_check: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    check_reason: Mapped[str | None] = mapped_column(String(300))
    exclude_from_stock: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")  # consumables, packaging
    item_code: Mapped[str | None] = mapped_column(String(50))
    vat_code: Mapped[str | None] = mapped_column(String(10))
    vat_rate: Mapped[Decimal | None] = mapped_column(Numeric(5, 2))


EXPENSE_CATEGORIES = ("Utilities", "Telecom", "Rent", "Cleaning", "Packaging", "Repairs", "Other")


class Expense(Base, TimestampMixin):
    """A bill that is not stock (broadband, rent, cleaning ...). Never touches the stock ledger."""
    __tablename__ = "expenses"
    __table_args__ = (
        Index("uq_expense_invoice", "restaurant_id", text_("lower(supplier_name)"), "invoice_number", unique=True,
              postgresql_where=text_("invoice_number IS NOT NULL")),
    )
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    supplier_id: Mapped[uuid.UUID | None] = fk("suppliers", nullable=True)
    supplier_name: Mapped[str] = mapped_column(String(200))
    invoice_number: Mapped[str | None] = mapped_column(String(100))
    expense_date: Mapped[date] = mapped_column(Date, index=True)
    category: Mapped[str] = mapped_column(String(30))
    net: Mapped[Decimal] = mapped_column(MONEY)
    vat: Mapped[Decimal] = mapped_column(MONEY, default=0)  # input GST / tax paid (column name kept for API compatibility)
    gross: Mapped[Decimal] = mapped_column(MONEY)
    note: Mapped[str | None] = mapped_column(String(300))
    invoice_id: Mapped[uuid.UUID | None] = fk("purchase_invoices", nullable=True)  # the scanned file, when there is one
    created_by: Mapped[uuid.UUID | None] = fk("users", nullable=True)


class SyncOperation(Base):
    """Receipt of an offline operation. Only successfully applied ops are stored, so op_id replays are no-ops."""
    __tablename__ = "sync_operations"
    __table_args__ = (UniqueConstraint("restaurant_id", "op_id"),)
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    op_id: Mapped[uuid.UUID] = mapped_column()
    op_type: Mapped[str] = mapped_column(String(30))
    device_id: Mapped[str | None] = mapped_column(String(64))
    client_created_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    result: Mapped[dict | None] = mapped_column(JSON)
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ConsentChannel(str, enum.Enum):
    whatsapp = "whatsapp"
    sms = "sms"
    email = "email"


class Customer(Base, TimestampMixin):
    __tablename__ = "customers"
    # Unique phone per restaurant when present (Postgres treats NULLs as distinct). Name and phone are each optional,
    # but a customer always has at least one of them.
    __table_args__ = (UniqueConstraint("restaurant_id", "phone"),
                      CheckConstraint("name IS NOT NULL OR phone IS NOT NULL", name="ck_customers_name_or_phone"))
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    name: Mapped[str | None] = mapped_column(String(200))
    phone: Mapped[str | None] = mapped_column(String(20))  # E.164, e.g. +971501234567
    email: Mapped[str | None] = mapped_column(String(255))
    notes: Mapped[str | None] = mapped_column(String(500))
    # India GST (B2B): the buyer's GSTIN and 2-digit state code (place of supply). Both optional.
    gstin: Mapped[str | None] = mapped_column(String(15))
    state_code: Mapped[str | None] = mapped_column(String(2))


class ConsentRecord(Base):
    """Append-only consent history. Current consent = latest row per (customer, channel)."""
    __tablename__ = "consent_records"
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    customer_id: Mapped[uuid.UUID] = fk("customers")
    channel: Mapped[ConsentChannel] = mapped_column(Enum(ConsentChannel, name="consent_channel"))
    granted: Mapped[bool] = mapped_column(Boolean)
    source: Mapped[str] = mapped_column(String(100))  # e.g. "verbal at counter", "web form"
    recorded_by: Mapped[uuid.UUID] = fk("users")
    recorded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)


class Alert(Base):
    """In-app alert / notification history. At most one OPEN alert per inventory item (deduplicated)."""
    __tablename__ = "alerts"
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    kind: Mapped[str] = mapped_column(String(30))  # low_stock
    item_id: Mapped[uuid.UUID] = fk("inventory_items")
    status: Mapped[str] = mapped_column(String(20), default="open")  # open | resolved
    message: Mapped[str] = mapped_column(String(300))
    balance: Mapped[Decimal] = mapped_column(Numeric(14, 3))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    acknowledged_by: Mapped[uuid.UUID | None] = fk("users", nullable=True)
    # Re-order email: pending = still to be emailed to the supplier; supplier_email_id = the email that covered this alert
    # (once set the alert is never emailed again; restocking resolves it, a later shortage is a NEW alert).
    email_pending: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    supplier_email_id: Mapped[uuid.UUID | None] = fk("supplier_emails", nullable=True)


Index("uq_alert_open_item", Alert.item_id, Alert.kind, unique=True, postgresql_where=(Alert.status == "open"))


class Conversation(Base):
    __tablename__ = "ai_conversations"
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    user_id: Mapped[uuid.UUID] = fk("users")
    title: Mapped[str] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    messages: Mapped[list["AiMessage"]] = relationship(cascade="all, delete-orphan", order_by="AiMessage.seq")


class AiMessage(Base):
    __tablename__ = "ai_messages"
    id: Mapped[uuid.UUID] = uuid_pk()
    conversation_id: Mapped[uuid.UUID] = fk("ai_conversations")
    seq: Mapped[int] = mapped_column(Integer)
    role: Mapped[str] = mapped_column(String(10))  # user | model
    content: Mapped[str] = mapped_column(String)
    tool_calls: Mapped[list | None] = mapped_column(JSON)  # [{name, args, result_summary}] for audit
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class LoginAttempt(Base):
    """Failed login attempts, persisted so throttling works across processes. A success clears the email's rows."""
    __tablename__ = "login_attempts"
    __table_args__ = (Index("ix_login_attempts_email_created", "email", "created_at"),
                      Index("ix_login_attempts_ip_created", "ip", "created_at"))
    id: Mapped[uuid.UUID] = uuid_pk()
    email: Mapped[str] = mapped_column(String(255))  # lower-cased; recorded for unknown emails too
    ip: Mapped[str | None] = mapped_column(String(64))  # client IP as uvicorn sees it (proxy headers only from trusted peers)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class AbuseCounter(Base):
    """Abuse counters per key (e.g. `pair:ip:<addr>`, `pair:code:<sha256>`, `pair:global`, `register:ip:<addr>`), persisted so a
    limit or lockout holds across workers and restarts (app/services/abuse.py). Not tenant data (the callers are
    unauthenticated): exempt from RLS like login_attempts."""
    __tablename__ = "abuse_counters"
    key: Mapped[str] = mapped_column(String(100), primary_key=True)
    failures: Mapped[int] = mapped_column(Integer, default=0)
    window_start: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class RefreshToken(Base):
    """Rotating refresh token, stored as a sha256 digest only. Every login starts a family; each refresh revokes
    the presented token (`replaced_by` -> successor). Presenting an already-rotated token outside the grace window
    revokes the whole family (theft detection)."""
    __tablename__ = "refresh_tokens"
    id: Mapped[uuid.UUID] = uuid_pk()
    user_id: Mapped[uuid.UUID] = fk("users")
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    family_id: Mapped[uuid.UUID] = mapped_column(index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # rotated | reuse_detected | logout | password_change | password_reset | deactivated | device_revoked | sign_out_all
    revoked_reason: Mapped[str | None] = mapped_column(String(30))
    replaced_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("refresh_tokens.id", ondelete="SET NULL"), nullable=True)
    device_label: Mapped[str | None] = mapped_column(String(200))  # from the client or its User-Agent
    # The signed-in device (models/devices.LoginDevice); NULL for tokens issued before device sessions existed.
    login_device_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("login_devices.id", ondelete="SET NULL"), nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class VoiceCommit(Base, TimestampMixin):
    """One confirmed voice order (POST /ai/voice-order/commit). `op_id` is the client's idempotency key: a replay finds this
    row and returns the same order / KOT instead of creating another."""
    __tablename__ = "voice_commits"
    __table_args__ = (UniqueConstraint("restaurant_id", "op_id"),)
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    op_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    order_id: Mapped[uuid.UUID] = fk("orders")
    kot_id: Mapped[uuid.UUID | None] = fk("kot_tickets", nullable=True)
    user_id: Mapped[uuid.UUID | None] = fk("users", nullable=True)


class VoiceTranscript(Base):
    """What was said (text only, never audio), kept for VOICE_TRANSCRIPT_RETENTION_DAYS and then purged. Not written at all
    when the retention is 0."""
    __tablename__ = "voice_transcripts"
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    user_id: Mapped[uuid.UUID | None] = fk("users", nullable=True)
    source: Mapped[str] = mapped_column(String(10))  # audio | text
    transcript: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)


class VoiceUsage(Base):
    """Per restaurant per UTC day: requests and estimated provider cost (millionths of a rupee) for the daily caps."""
    __tablename__ = "voice_usage"
    restaurant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("restaurants.id"), primary_key=True)
    day: Mapped[date] = mapped_column(Date, primary_key=True)
    requests: Mapped[int] = mapped_column(Integer, default=0)
    cost_micros: Mapped[int] = mapped_column(Integer, default=0)


class VoiceAlias(Base, TimestampMixin):
    """A phrase the till learnt from staff corrections ("chicken tikki" -> Chicken Tikka), shared by every device of the
    restaurant. `phrase` is the on-device parser's normalised key (lower case, quantities / fillers / notes removed; see
    apps/web/src/lib/voiceParse.ts aliasPhrase). Deleting the dish deletes its phrases; a deleted option just clears."""
    __tablename__ = "voice_aliases"
    __table_args__ = (UniqueConstraint("restaurant_id", "phrase"),)
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    phrase: Mapped[str] = mapped_column(String(200))
    menu_item_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("menu_items.id", ondelete="CASCADE"), index=True)
    variant_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("menu_variants.id", ondelete="SET NULL"), nullable=True)
    uses: Mapped[int] = mapped_column(Integer, default=1, server_default="1")  # times staff confirmed it
    created_by: Mapped[uuid.UUID | None] = fk("users", nullable=True)
    item: Mapped[MenuItem] = relationship()
    variant: Mapped[MenuVariant | None] = relationship()


class Printer(Base):
    """A receipt / kitchen printer of the restaurant. The print hub on the restaurant's PC delivers the ESC/POS bytes
    (docs/print-hub-contract.md). lan = raw TCP host:port; system = a named OS print queue on the hub PC (USB / serial)."""
    __tablename__ = "printers"
    __table_args__ = (UniqueConstraint("outlet_id", "name"),)
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    outlet_id: Mapped[uuid.UUID] = outlet_col()
    name: Mapped[str] = mapped_column(String(100))
    role: Mapped[str] = mapped_column(String(10), default="counter", server_default="counter")  # counter|kitchen|other
    connection: Mapped[str] = mapped_column(String(10), default="lan", server_default="lan")  # lan|system
    host: Mapped[str | None] = mapped_column(String(255))
    port: Mapped[int] = mapped_column(Integer, default=9100, server_default="9100")
    system_name: Mapped[str | None] = mapped_column(String(255))
    columns: Mapped[int] = mapped_column(Integer, default=42, server_default="42")
    codepage: Mapped[str] = mapped_column(String(10), default="pc858", server_default="pc858")  # pc858|cp1252|none
    copies: Mapped[int] = mapped_column(Integer, default=1, server_default="1")
    cut: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    auto_bill: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    auto_kot: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    kot_category_ids: Mapped[list[uuid.UUID]] = mapped_column(
        ARRAY(UUID(as_uuid=True)), default=list, server_default=text_("'{}'::uuid[]"))  # empty = every category
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class PrintHub(Base):
    """The always-on program in the restaurant. Authenticates with a random 32-byte token; only its sha256 is stored."""
    __tablename__ = "print_hubs"
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    outlet_id: Mapped[uuid.UUID] = outlet_col()
    name: Mapped[str] = mapped_column(String(100))
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    version: Mapped[str | None] = mapped_column(String(40))
    os: Mapped[str | None] = mapped_column(String(40))
    system_printers: Mapped[list | None] = mapped_column(JSON)
    printer_status: Mapped[dict | None] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class HubPairing(Base):
    """A 6-digit code the owner reads into the hub (single use, 15 minutes). Only its sha256 is stored."""
    __tablename__ = "hub_pairings"
    id: Mapped[uuid.UUID] = uuid_pk()
    code_hash: Mapped[str] = mapped_column(String(64), index=True)
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    outlet_id: Mapped[uuid.UUID] = outlet_col()
    created_by: Mapped[uuid.UUID | None] = fk("users", nullable=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class PrintJob(Base):
    """One print of one document on one printer. `payload` holds the finished ESC/POS bytes (rendered at enqueue time)."""
    __tablename__ = "print_jobs"
    __table_args__ = (
        # A bill finalized twice / a replayed request never prints twice (ref_id null = test pages, never deduplicated).
        Index("uq_print_jobs_ref", "printer_id", "kind", "ref_id", "copy_no", "reprint_no", unique=True,
              postgresql_where=text_("ref_id IS NOT NULL")),
        Index("ix_print_jobs_queue", "restaurant_id", "status", "created_at"),
        # the cross-tenant sweep (definer.print_sweep_tenants) only ever looks at open jobs
        Index("ix_print_jobs_open", "status", "created_at", postgresql_where=text_("status IN ('queued', 'sent')")),
    )
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    outlet_id: Mapped[uuid.UUID] = outlet_col()
    printer_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("printers.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(10))  # bill|kot|test
    ref_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)  # bill id / kot id
    copy_no: Mapped[int] = mapped_column(Integer, default=1, server_default="1")
    reprint_no: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    payload: Mapped[bytes] = mapped_column(LargeBinary)
    status: Mapped[str] = mapped_column(String(10), default="queued", server_default="queued")  # queued|sent|printed|failed
    attempts: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    last_error: Mapped[str | None] = mapped_column(String(500))
    created_by: Mapped[uuid.UUID | None] = fk("users", nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    printed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    retry_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))  # a failed attempt waits until then (backoff)


# Outlet-scoped tables (docs/OUTLETS.md): each has outlet_id and the composite FK (outlet_id, restaurant_id) ->
# outlets (id, restaurant_id), which makes "an outlet of another tenant" impossible whatever the application does.
OUTLET_TABLES: tuple[str, ...] = (
    "devices", "dining_tables", "orders", "kot_tickets", "bills", "payments", "refunds",
    "printers", "print_hubs", "hub_pairings", "print_jobs",
    "online_payments", "cash_sessions",  # payments-service integration; cash sessions
    "shifts", "table_assignments",  # waiter app
    "invoice_sequences", "z_reports",  # PR 6: counters and end-of-day reports are per outlet
)
for _t in OUTLET_TABLES:
    Base.metadata.tables[_t].append_constraint(ForeignKeyConstraint(
        ["outlet_id", "restaurant_id"], ["outlets.id", "outlets.restaurant_id"], name=f"fk_{_t}_outlet"))


class UserMfa(Base, TimestampMixin):
    """Optional TOTP second factor of an owner / manager (security review finding 7; docs/AUTH_CONTRACT.md). The secret is
    Fernet-encrypted (MFA_ENCRYPTION_KEY) because TOTP needs it in clear to verify; recovery codes are stored as sha256 only.
    confirmed_at NULL = enrolment started, not active yet."""
    __tablename__ = "user_mfa"
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), unique=True)
    secret_enc: Mapped[str] = mapped_column(String(300))
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_step: Mapped[int | None] = mapped_column(Integer)  # the last accepted time step: a code works once
    recovery_hashes: Mapped[list] = mapped_column(JSONB, default=list)  # sha256 of the unused recovery codes


class PasswordResetToken(Base):
    """Single-use password reset token, stored as a sha256 digest only. Looked up by (restaurant_id, hash) inside the tenant the
    emailed link names, so RLS applies to the lookup."""
    __tablename__ = "password_reset_tokens"
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class WhatsAppOutbox(Base, TimestampMixin):
    """A WhatsApp message to send: written in the business operation's transaction, delivered later by the runner with retry
    and backoff. status: queued | sent | dead (gave up) | skipped (opted out / not allowed). Provider failure never fails the
    business operation."""
    __tablename__ = "whatsapp_outbox"
    __table_args__ = (UniqueConstraint("restaurant_id", "dedupe_key"),)
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    kind: Mapped[str] = mapped_column(String(20))  # receipt_link | bill_ready | text
    mode: Mapped[str] = mapped_column(String(10))  # template | text
    to_phone: Mapped[str] = mapped_column(String(20))  # E.164
    template: Mapped[str | None] = mapped_column(String(80))
    language: Mapped[str | None] = mapped_column(String(10))
    variables: Mapped[list] = mapped_column(JSONB, default=list)  # ordered body parameters
    body: Mapped[str | None] = mapped_column(Text)  # free text (mode = text)
    bill_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    status: Mapped[str] = mapped_column(String(10), default="queued", server_default="queued")
    attempts: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    next_attempt_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)
    last_error: Mapped[str | None] = mapped_column(String(500))
    provider_message_id: Mapped[str | None] = mapped_column(String(100))
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    dedupe_key: Mapped[str | None] = mapped_column(String(100))
    created_by: Mapped[uuid.UUID | None] = fk("users", nullable=True)


class WhatsAppContact(Base):
    """Per phone number (E.164), shared by all tenants because customers write to the platform's one WhatsApp number and the
    inbound webhook does not know a tenant: opt-out state and the last inbound message (opens the 24-hour free-text window).
    Deliberately without RLS (documented exception, app/core/rls.py EXEMPT_TABLES); holds no tenant data."""
    __tablename__ = "whatsapp_contacts"
    phone: Mapped[str] = mapped_column(String(20), primary_key=True)
    opted_out_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_inbound_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

from app.models import inventory as _inventory_models  # noqa: E402,F401  (registers the procurement / stock tables)

# ------------------------------------------------------------------------------------------------ delivery (docs/DELIVERY_API.md)
DELIVERY_STATES = ("placed", "accepted", "preparing", "ready", "out_for_delivery", "delivered", "cancelled")


class DeliverySettings(Base):
    """Per-tenant delivery configuration (one row per restaurant, created on first PUT /delivery/settings)."""
    __tablename__ = "delivery_settings"
    restaurant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("restaurants.id"), primary_key=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    # false (default): a delivery order goes to the kitchen at once. true: it waits in `placed` until staff accept it.
    accept_before_kot: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    delivery_fee: Mapped[Decimal] = mapped_column(MONEY, default=0, server_default="0")
    free_delivery_above: Mapped[Decimal | None] = mapped_column(MONEY)
    min_order: Mapped[Decimal] = mapped_column(MONEY, default=0, server_default="0")
    radius_km: Mapped[Decimal | None] = mapped_column(Numeric(6, 2))
    # {"mon": [["11:00", "22:00"]], ...} in the restaurant's timezone; null = always open.
    hours: Mapped[dict | None] = mapped_column(JSON)
    webhook_url: Mapped[str | None] = mapped_column(String(500))
    webhook_secret: Mapped[str | None] = mapped_column(String(100))  # per-restaurant HMAC key; shown once on rotation
    # Public ordering link (docs/DELIVERY_API.md "Public ordering link"). delivery-service owns the slug: here only the owner's
    # choice, a cache of the last URL it returned, and the Fernet-encrypted token pos-service calls it with (never returned, never logged).
    public_order_enabled: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    public_order_url: Mapped[str | None] = mapped_column(String(500))
    service_token_enc: Mapped[str | None] = mapped_column(String(600))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class DeliveryOrder(Base):
    """Delivery data and state of one order (1:1 with `orders`). `orders`/`kot_tickets` keep the kitchen truth; this row holds
    the customer/address/money snapshot, the delivery state and the per-order monotonic `version` of the webhook events."""
    __tablename__ = "delivery_orders"
    __table_args__ = (UniqueConstraint("restaurant_id", "idempotency_key"), UniqueConstraint("order_id"))
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    order_id: Mapped[uuid.UUID] = fk("orders")
    outlet_id: Mapped[uuid.UUID] = outlet_col()
    idempotency_key: Mapped[str] = mapped_column(String(128))
    request_hash: Mapped[str] = mapped_column(String(64))
    order_code: Mapped[str] = mapped_column(String(20))
    delivery_status: Mapped[str] = mapped_column(String(20), default="placed")
    version: Mapped[int] = mapped_column(Integer, default=1)
    channel: Mapped[str] = mapped_column(String(20))
    customer_name: Mapped[str] = mapped_column(String(200))
    customer_phone: Mapped[str | None] = mapped_column(String(30))
    address_text: Mapped[str] = mapped_column(String(500))
    lat: Mapped[Decimal | None] = mapped_column(Numeric(9, 6))
    lng: Mapped[Decimal | None] = mapped_column(Numeric(9, 6))
    subtotal: Mapped[Decimal] = mapped_column(MONEY)
    delivery_fee: Mapped[Decimal] = mapped_column(MONEY)
    tax: Mapped[Decimal] = mapped_column(MONEY)
    total: Mapped[Decimal] = mapped_column(MONEY)
    payment_mode: Mapped[str] = mapped_column(String(10))
    claimed_paid: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")  # a claim, never proof
    payment_ref: Mapped[str | None] = mapped_column(String(100))
    payment_confirmed: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class DeliveryOutbox(Base):
    """Transactional outbox of the status webhooks to delivery-service: written in the same transaction as the state change,
    sent by services/delivery_outbox.py. `event_id` is fixed at creation so every retry carries the same id (receiver dedupe)."""
    __tablename__ = "delivery_outbox"
    __table_args__ = (
        UniqueConstraint("event_id"),
        Index("ix_delivery_outbox_due", "next_attempt_at", postgresql_where=text_("status = 'pending'")),
    )
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    order_id: Mapped[uuid.UUID] = fk("orders")
    event_id: Mapped[str] = mapped_column(String(64))
    event_type: Mapped[str] = mapped_column(String(40))
    version: Mapped[int] = mapped_column(Integer)
    payload: Mapped[dict] = mapped_column(JSON)
    status: Mapped[str] = mapped_column(String(10), default="pending", server_default="pending")  # pending | sent | dead
    attempts: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    next_attempt_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    last_error: Mapped[str | None] = mapped_column(String(300))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


from sqlalchemy import BigInteger as _BigInteger  # noqa: E402


class BillingUsageOutbox(Base):
    """PAYG metering (docs/PAYG_BILLING.md): one row per (bill, event) written in the SAME transaction that finalizes / voids the
    bill, so a bill is reported exactly when it exists, offline-synced bills included. services/wallet.py sends the rows to
    platform-core (which holds the wallet and debits ₹5 per bill); a row is never dropped, only retried. `bill_id` is the ROOT
    bill of an amendment chain: a corrected bill is the same sale and is never charged again."""
    __tablename__ = "billing_usage_outbox"
    __table_args__ = (
        UniqueConstraint("restaurant_id", "bill_id", "event", name="uq_billing_usage_bill_event"),
        CheckConstraint("event IN ('finalized', 'voided')", name="ck_billing_usage_event"),
        CheckConstraint("status IN ('pending', 'sent', 'unmanaged')", name="ck_billing_usage_status"),
        Index("ix_billing_usage_outbox_due", "next_attempt_at", postgresql_where=text_("status IN ('pending', 'unmanaged')")),
    )
    id: Mapped[uuid.UUID] = uuid_pk()
    restaurant_id: Mapped[uuid.UUID] = fk("restaurants")
    bill_id: Mapped[uuid.UUID] = fk("bills")
    event: Mapped[str] = mapped_column(String(10))
    outlet_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    invoice_number: Mapped[str | None] = mapped_column(String(40))
    bill_total_paise: Mapped[int] = mapped_column(_BigInteger, default=0)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    offline: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    status: Mapped[str] = mapped_column(String(10), default="pending", server_default="pending")
    attempts: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    next_attempt_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    last_error: Mapped[str | None] = mapped_column(String(300))
    outcome: Mapped[str | None] = mapped_column(String(24))  # platform-core's answer: charged | trial | zero_total | ...
    charged_paise: Mapped[int | None] = mapped_column(_BigInteger)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
