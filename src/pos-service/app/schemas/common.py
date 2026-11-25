import re
import uuid
from datetime import datetime
from decimal import Decimal

from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, EmailStr, Field, computed_field, field_validator, model_serializer, model_validator

from app.core import password_policy
from app.models.core import MENU_DESCRIPTION_MAX, KotStatus, OrderStatus, OrderType, PaymentMethod, Role


class ORM(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class LoginIn(BaseModel):
    """Two ways to sign in (docs/STAFF_WIRING_CHECK.md "Login schemes"):

    * email + password (owners, managers, anyone with an email). `restaurant_id` picks one restaurant when the email has
      accounts in several.
    * restaurant code + identifier + password (staff, who often have no email): `restaurant_code` (6 characters, shown in
      Manage > Restaurant and on the staff card) and `identifier` = phone, username or email, unique inside that restaurant.

    Compatibility for clients that only know the email form (the waiter app): a non-UUID `restaurant_id` is read as a
    restaurant code, and an `email` without '@' is read as the identifier."""
    email: str | None = Field(default=None, max_length=320)
    identifier: str | None = Field(default=None, max_length=320)
    restaurant_code: str | None = Field(default=None, max_length=16)
    password: str = Field(max_length=1024)
    restaurant_id: uuid.UUID | None = None
    device_label: str | None = Field(default=None, max_length=200)  # optional, e.g. "Counter tablet"

    @model_validator(mode="before")
    @classmethod
    def _compat(cls, v):
        if not isinstance(v, dict):
            return v
        v = dict(v)
        rid = v.get("restaurant_id")
        if isinstance(rid, str) and rid.strip() and not _is_uuid(rid.strip()):
            if not v.get("restaurant_code"):
                v["restaurant_code"] = rid
            v["restaurant_id"] = None
        if v.get("restaurant_code") and not v.get("identifier") and v.get("email"):
            v["identifier"], v["email"] = v["email"], None
        return v

    @model_validator(mode="after")
    def _shape(self):
        if self.restaurant_code is not None:
            self.restaurant_code = self.restaurant_code.strip().upper().replace("-", "").replace(" ", "")
            if not self.restaurant_code:
                self.restaurant_code = None
        if self.restaurant_code:
            if not (self.identifier or "").strip():
                raise ValueError("Enter your phone number, username or email")
            return self
        if not self.email or "@" not in self.email:
            raise ValueError("Enter your email, or your restaurant code with your phone number or username")
        try:
            from email_validator import validate_email
            self.email = validate_email(self.email.strip(), check_deliverability=False).normalized
        except Exception:
            raise ValueError("Enter a valid email address")
        return self


def _is_uuid(v: str) -> bool:
    try:
        uuid.UUID(v)
        return True
    except ValueError:
        return False


class TokenOut(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    expires_in: int  # access token lifetime in seconds
    # True when the password was a one-time password from the owner: ask for a new one (POST /auth/change-password).
    password_change_required: bool = False


class RefreshIn(BaseModel):
    refresh_token: str = Field(min_length=1, max_length=200)


class UserCreate(BaseModel):
    """A staff member. At least one of email / phone / username. Credentials, in this order:
    `password` given -> that password; else `send_invite` (needs email) -> an emailed single-use link to choose one;
    else the server generates a one-time password, returned ONCE in the answer (`temporary_password`)."""
    email: EmailStr | None = None
    phone: str | None = Field(default=None, max_length=30)
    username: str | None = Field(default=None, max_length=40)
    full_name: str = Field(min_length=1, max_length=200)
    password: str | None = Field(default=None, min_length=10, max_length=256)
    role: Role
    outlet_ids: list[uuid.UUID] | None = Field(default=None, max_length=200)  # None/[] = the default outlet only
    send_invite: bool = False

    @model_validator(mode="after")
    def _identifiers(self):
        from app.services import staff_accounts as sa
        self.email = self.email.strip().lower() if self.email else None
        self.phone = sa.normalise_phone(self.phone) if self.phone and self.phone.strip() else None
        self.username = sa.normalise_username(self.username) if self.username and self.username.strip() else None
        if not (self.email or self.phone or self.username):
            raise ValueError("Give an email, a phone number or a username")
        if self.send_invite and not self.email:
            raise ValueError("An invite needs an email address")
        return self

    @model_validator(mode="after")
    def _password_policy(self):  # security review finding 7 (no password = invite or server one-time password)
        if self.password is not None:
            password_policy.validate(self.password, self.email or self.username or self.phone, self.full_name)
        return self


class UserOut(ORM):
    id: uuid.UUID
    email: str | None = None
    phone: str | None = None
    username: str | None = None
    full_name: str
    role: Role
    is_active: bool
    custom_role_id: uuid.UUID | None = None
    must_change_password: bool = False


class StaffOut(UserOut):
    created_at: datetime


class StaffInviteOut(BaseModel):
    sent: bool  # the email was handed to the mailer (false: mail is not set up; share `url` yourself)
    url: str  # single-use link, shown once
    expires_at: datetime


class StaffCreatedOut(UserOut):
    """The new staff member plus their sign-in details. `temporary_password` and `invite.url` are shown ONCE."""
    restaurant_code: str
    login_identifier: str  # what they type next to the restaurant code: phone, else username, else email
    temporary_password: str | None = None
    invite: StaffInviteOut | None = None
    outlet_ids: list[uuid.UUID] = []


class TemporaryPasswordOut(BaseModel):
    temporary_password: str  # shown once; the user must choose a new one at the next sign-in
    restaurant_code: str
    login_identifier: str


class UserPatch(BaseModel):
    full_name: str | None = Field(default=None, min_length=1, max_length=200)
    role: Role | None = None
    # Sign-in identifiers (owner / staff.manage_roles): "" or null clears one, but a user always keeps at least one.
    email: EmailStr | None = None
    phone: str | None = Field(default=None, max_length=30)
    username: str | None = Field(default=None, max_length=40)


TaxKind = Literal["hot_food", "cold_food", "standard"]  # stored label only, no tax effect (see MenuItem.tax_kind)
# India only (owner decision 2026-10-31): a country / currency field, where a request accepts one, takes only these values
# (anything else is a 422). They exist for forward compatibility; omitting them means the same thing.
CountryCode = Literal["IN"]
CurrencyCode = Literal["INR"]
BusinessTypeId = Literal["restaurant", "cloud_kitchen", "hotel_kitchen"]
KitchenStatusMode = Literal["kot_only", "track"]  # restaurants.kitchen_status_mode (docs/KOT_ONLY_KITCHEN.md)


def _canonical_types(v: list[str]) -> list[str]:
    from app.services.business_type import normalize
    return normalize(v)


# One or more business types (docs/BUSINESS_TYPES.md); deduped into the canonical order, never empty.
BusinessTypes = Annotated[list[BusinessTypeId], Field(min_length=1, max_length=10), AfterValidator(_canonical_types)]


def check_tax_number(value: str | None) -> str | None:
    """Normalises (strips spaces/dashes, upper-case) and validates a GSTIN; ValueError if bad."""
    from app.services.localisation import check_gstin
    return check_gstin(value)


class RegisterRestaurantIn(BaseModel):
    restaurant_name: str = Field(min_length=1, max_length=200)
    country: CountryCode = "IN"  # optional; anything but IN is a 422
    trn: str | None = Field(default=None, max_length=30)  # the GSTIN (optional; validated when given)
    # What the business runs (sign-up step 'What do you run? (choose one or more)'). Absent = ["restaurant"].
    business_types: BusinessTypes = Field(default_factory=lambda: ["restaurant"])
    owner_email: EmailStr
    owner_name: str
    owner_password: str = Field(min_length=10)

    @field_validator("trn")
    @classmethod
    def _gstin(cls, v: str | None) -> str | None:
        return check_tax_number(v)

    @model_validator(mode="after")
    def _password_policy(self):
        password_policy.validate(self.owner_password, self.owner_email, self.owner_name)  # security review finding 7
        return self


class CategoryIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    sort_order: int = 0


class CategoryOut(ORM):
    id: uuid.UUID
    name: str
    sort_order: int
    is_active: bool


class VariantIn(BaseModel):
    id: uuid.UUID | None = None  # on update: an existing variant of this item; omitted = new variant
    name: str = Field(min_length=1, max_length=100)
    price_delta: Decimal = Field(default=Decimal("0"), max_digits=12, decimal_places=2)
    is_default: bool = False  # the option an order line gets when it names none (at most one per item)


class VariantOut(ORM):
    id: uuid.UUID
    name: str
    price_delta: Decimal
    is_default: bool = False


FoodType = Literal["veg", "non_veg", "egg"]
_FOOD_ALIASES = {"veg": "veg", "vegetarian": "veg", "non_veg": "non_veg", "nonveg": "non_veg", "non_vegetarian": "non_veg",
                 "egg": "egg", "eggetarian": "egg", "contains_egg": "egg"}


def clean_food_type(v):
    """'Veg', 'non-veg', 'Non Veg' -> 'veg' / 'non_veg' (spreadsheets and old clients spell it many ways); '' -> None (not
    marked). Anything else is left for the Literal to reject with a 422."""
    if isinstance(v, str):
        k = re.sub(r"[\s\-]+", "_", v.strip().lower())
        return None if not k else _FOOD_ALIASES.get(k, v)
    return v


def clean_description(v):
    """One line, at most MENU_DESCRIPTION_MAX characters: whitespace runs (newlines, tabs) collapse to one space, the ends are
    trimmed, '' -> None. Other control characters are refused (they print as garbage on cards and online menus)."""
    if v is None:
        return None
    if not isinstance(v, str):
        raise ValueError("description must be text")
    s = re.sub(r"\s+", " ", v).strip()
    if re.search(r"[\x00-\x1f\x7f]", s):
        raise ValueError("description cannot contain control characters")
    if len(s) > MENU_DESCRIPTION_MAX:
        raise ValueError(f"description is limited to {MENU_DESCRIPTION_MAX} characters")
    return s or None


class _MenuMeta(BaseModel):
    """food_type / description, shared by create, update and PATCH. On update and PATCH an OMITTED field is unchanged and an
    explicit null (or "") clears it, so clients that predate the fields never wipe them (docs/MENU_META.md)."""
    food_type: FoodType | None = None
    description: str | None = None

    @field_validator("food_type", mode="before")
    @classmethod
    def _food(cls, v):
        return clean_food_type(v)

    @field_validator("description", mode="before")
    @classmethod
    def _desc(cls, v):
        return clean_description(v)

    def meta_sent(self) -> dict:
        return {k: getattr(self, k) for k in ("food_type", "description") if k in self.model_fields_set}


class ItemIn(_MenuMeta):
    category_id: uuid.UUID
    name: str = Field(min_length=1, max_length=200)
    price: Decimal = Field(ge=0, max_digits=12, decimal_places=2)
    # None: "standard" on create, unchanged on update. A stored label only: it does not change the tax.
    tax_kind: TaxKind | None = None
    # India GST (used only when the restaurant's tax_mode is gst_engine). None = unchanged on update / default on create.
    hsn: str | None = Field(default=None, pattern=r"^([0-9]{4}|[0-9]{6}|[0-9]{8})$")
    supply_type: Literal["restaurant", "goods", "other"] | None = None
    gst_rate_code: str | None = Field(default=None, max_length=20)
    # On update, None (omitted) leaves variants unchanged; a list is the complete new set.
    variants: list[VariantIn] | None = None


class ItemPatch(_MenuMeta):
    """PATCH /menu/items/{id}: the descriptive fields only (price, name and tax keep their audited PUT). At least one field."""
    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def _something(self):
        if not self.model_fields_set:
            raise ValueError("send food_type and/or description")
        return self


class ItemOut(ORM):
    id: uuid.UUID
    category_id: uuid.UUID
    name: str
    price: Decimal
    tax_kind: TaxKind = "standard"
    hsn: str | None = None
    supply_type: str = "restaurant"
    gst_rate_code: str | None = None
    # docs/MENU_META.md: veg | non_veg | egg, null = not marked; description null = none. Never printed on KOTs or bills.
    food_type: FoodType | None = None
    description: str | None = None
    is_active: bool
    variants: list[VariantOut]
    # docs/MODIFIERS_OFFERS.md: ids of the ACTIVE modifier groups the item offers, in order (definitions: GET
    # /menu/modifier-groups), and whether it is a combo (components: GET /menu/combos). Empty / false when not configured.
    modifier_group_ids: list[uuid.UUID] = []
    is_combo: bool = False
    # API-relative paths (prefix with the API origin); None when the item has no photo. URLs change when the photo does.
    image_url: str | None = None
    thumb_url: str | None = None
    # Order rules (docs/ORDER_RULES.md). sold_out: marked sold out for today (cannot be ordered; resets tomorrow).
    # default_variant_id: the option the server applies when a line names none (null = none applied). base_orderable: the dish
    # may be ordered WITHOUT an option (no options, or every option costs extra): only then may a UI offer a "Regular" row.
    sold_out: bool = False
    default_variant_id: uuid.UUID | None = None
    base_orderable: bool = True

    @field_validator("variants", mode="before")
    @classmethod
    def _active_only(cls, v):  # deactivated variants stay in the DB for history but are never offered
        return [x for x in v if getattr(x, "is_active", True) is not False]


class RestaurantOut(ORM):
    name: str
    login_code: str | None = None  # staff sign-in code (restaurant code + phone / username + password)
    trn: str | None
    address: str | None = None
    phone: str | None = None
    z_report_next_number: int = 1
    currency: str
    timezone: str  # IANA name, the stored value ("Asia/Kolkata"); use it for date maths
    country: str = "IN"
    currency_symbol: str = "\u20b9"

    @computed_field  # display text of `timezone` for headers ("India (IST)"), never a city name; docs/INDIA.md
    @property
    def timezone_label(self) -> str:
        from app.services.localisation import timezone_label
        return timezone_label(self.timezone)

    tax_word: str = "GST"  # what to call the tax in the UI: always GST (India only)
    tax_number_label: str = "GSTIN"
    prices_include_tax: bool = False
    vat_registered: bool = True
    service_charge_percent: Decimal = Decimal("0")
    max_cashier_discount_percent: Decimal = Decimal("10")
    bill_amend_days: int = 30
    allow_negative_stock: bool = True
    kitchen_target_minutes: int = 15  # minutes after which a kitchen ticket / open order shows as late (5-120)
    upi_vpa: str | None = None  # UPI id for static QR codes (PUT /restaurant/upi); null = not set
    require_kot_before_bill: bool = True  # dine-in bills need every item sent to the kitchen first (docs/ORDER_RULES.md)
    kitchen_display_minutes: int = 20  # KOT-only kitchen screen: a ticket stays in the live list this long, then moves to "Earlier tickets" (5-120)
    kitchen_status_mode: KitchenStatusMode = "kot_only"  # docs/KOT_ONLY_KITCHEN.md: kot_only (kitchen taps Done) | track (preparing / ready / served)
    entitlement_warning: str | None = None  # past_due / entitlements_stale / suspended (warn mode); null = nothing to show
    business_types: list[str] = ["restaurant"]  # docs/BUSINESS_TYPES.md
    capabilities: dict | None = None  # union over business_types (+ delivery / aggregator modules); UIs hide what is false
    # code -> available (super admin granted it AND the owner has not switched it off): order.indoor, billing.discount, reports, ...
    features: dict[str, bool] | None = None  # services/feature_access.py; absent from an older server = everything allowed


class TableIn(BaseModel):
    label: str
    seats: int = Field(default=4, ge=1)
    area: OrderType = OrderType.indoor


class TableOut(ORM):
    id: uuid.UUID
    label: str
    seats: int
    area: OrderType
    is_active: bool = True


class TablePatch(BaseModel):
    label: str | None = Field(default=None, min_length=1, max_length=50)
    seats: int | None = Field(default=None, ge=1)
    area: OrderType | None = None
    is_active: bool | None = None


class RestaurantIn(BaseModel):
    """name / trn / address are always replaced (trn, address may be null). The tax settings are optional:
    omitted (or null) = unchanged. `trn` is the GSTIN (validated). `country` / `currency` may be sent only as IN / INR."""
    name: str = Field(min_length=1, max_length=200)
    trn: str | None = Field(default=None, max_length=30)
    country: CountryCode | None = None
    currency: CurrencyCode | None = None
    address: str | None = Field(default=None, max_length=500)
    vat_registered: bool | None = None
    service_charge_percent: Decimal | None = Field(default=None, ge=0, le=30, max_digits=5, decimal_places=2)
    max_cashier_discount_percent: Decimal | None = Field(default=None, ge=0, le=100, max_digits=5, decimal_places=2)
    prices_include_tax: bool | None = None
    # phone: omitted = unchanged; null or "" = clear. Printed on bills and Z/X reports.
    phone: str | None = Field(default=None, max_length=30)
    # First Z-report number (continue the old till's sequence). Omitted = unchanged; 409 once a Z report exists.
    z_report_next_number: int | None = Field(default=None, ge=1, le=99_999_999)
    # Days after the sale date during which a finalized bill can be corrected (credit note + replacement). 0 = off.
    bill_amend_days: int | None = Field(default=None, ge=0, le=366)
    # false: a posting that would take stock below zero is refused (409). Omitted = unchanged. Default true (legacy behaviour).
    allow_negative_stock: bool | None = None
    # Kitchen lateness target in minutes (KDS / order list colours). Omitted = unchanged; 5..120.
    kitchen_target_minutes: int | None = Field(default=None, ge=5, le=120)
    # Dine-in orders must go to the kitchen before the bill (docs/ORDER_RULES.md). Omitted = unchanged. Default true.
    require_kot_before_bill: bool | None = None
    # Kitchen status tracking (docs/KOT_ONLY_KITCHEN.md): "kot_only" (default) | "track". Omitted = unchanged.
    kitchen_status_mode: KitchenStatusMode | None = None
    # KOT-only kitchen screen: "Show tickets for N minutes" (5..120, default 20). Omitted = unchanged.
    kitchen_display_minutes: int | None = Field(default=None, ge=5, le=120)

    @field_validator("phone")
    @classmethod
    def _phone(cls, v: str | None) -> str | None:
        v = (v or "").strip()
        if v and not re.fullmatch(r"[0-9+()\-./ ]{3,30}", v):
            raise ValueError("Phone may contain digits, spaces and + ( ) - . / only")
        return v or None


class TaxKindUpdate(BaseModel):
    item_id: uuid.UUID
    tax_kind: TaxKind


class TaxKindsIn(BaseModel):
    updates: list[TaxKindUpdate] = Field(min_length=1, max_length=500)


class CategoryPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    sort_order: int | None = None
    is_active: bool | None = None


class CategoryOrderIn(BaseModel):
    ids: list[uuid.UUID]


class ItemActiveIn(BaseModel):
    is_active: bool


MAX_ORDER_LINES = 500  # lines per request (an order, an addition, a sync add_lines op): a bound, far above any real ticket


class OrderLineIn(BaseModel):
    item_id: uuid.UUID
    variant_id: uuid.UUID | None = None
    quantity: int = Field(ge=1, le=999)
    note: str | None = Field(default=None, max_length=300)
    expected_unit_price: Decimal | None = None  # offline price shown to customer; mismatch => conflict
    # Chosen modifier option ids (docs/MODIFIERS_OFFERS.md). Omitted (null) = the item's default options, which is what every
    # client that does not know modifiers sends; a list (even empty) is taken as the complete choice and validated.
    modifiers: list[uuid.UUID] | None = Field(default=None, max_length=50)


class OrderIn(BaseModel):
    client_uuid: uuid.UUID  # idempotency key / offline UUID
    order_type: OrderType
    table_id: uuid.UUID | None = None
    customer_id: uuid.UUID | None = None
    note: str | None = Field(default=None, max_length=300)  # free text for the whole order (optional: old clients omit it)
    lines: list[OrderLineIn] = Field(min_length=1, max_length=MAX_ORDER_LINES)
    # A table with an unpaid order refuses a second one (409 table_has_open_order) unless the client explicitly starts a
    # separate order (docs/ORDER_RULES.md). Old clients omit it.
    allow_second_order: bool = False


class OrderLinePatch(BaseModel):
    """Change a line the kitchen has NOT been sent yet. Omitted = unchanged; note null / "" clears it."""
    quantity: int | None = Field(default=None, ge=1, le=999)
    note: str | None = Field(default=None, max_length=300)


class SoldOutIn(BaseModel):
    sold_out: bool  # true = sold out for the rest of today (restaurant timezone); false = available again


class OrderLinesIn(BaseModel):
    batch_uuid: uuid.UUID  # idempotency key: a replay with the same value adds nothing
    lines: list[OrderLineIn] = Field(min_length=1, max_length=MAX_ORDER_LINES)
    accept_price_changes: bool = False


class OrderLineOut(ORM):
    id: uuid.UUID
    item_id: uuid.UUID
    item_name: str
    unit_price: Decimal  # includes the variant and modifier price deltas
    quantity: int
    note: str | None
    variant_id: uuid.UUID | None = None
    modifiers: list[dict] | None = None   # [{group_id, group, option_id, name, price_delta_paise}]; null = none
    components: list[dict] | None = None  # combo lines: [{item_id, item, variant_id, qty}] per one combo; null otherwise
    # true when the line named no option and the server applied the dish's default one (item_name says which, e.g.
    # "Butter Chicken (Half)"); only on the response that created the line.
    variant_defaulted: bool = False


class OrderKotSummary(BaseModel):
    """A kitchen ticket of the order, for lateness colours: `created_at` = sent to the kitchen, `updated_at` = last status change,
    `done_at` = the kitchen tapped Done (null while it is still on the kitchen screen)."""
    id: uuid.UUID
    number: int
    status: KotStatus
    created_at: datetime | None = None
    updated_at: datetime | None = None
    done_at: datetime | None = None


class OrderOut(ORM):
    id: uuid.UUID
    client_uuid: uuid.UUID
    order_type: OrderType
    table_id: uuid.UUID | None
    customer_id: uuid.UUID | None = None
    status: OrderStatus
    lines: list[OrderLineOut]
    subtotal: Decimal = Decimal("0")  # tax-exclusive; set by route, tax computed at billing
    cancel_reason: str | None = None
    cancelled_at: datetime | None = None
    created_at: datetime | None = None
    token_number: int | None = None  # per outlet per day (null on orders from before tokens)
    note: str | None = None
    bill_requested_at: datetime | None = None  # set by POST /orders/{id}/request-bill, cleared when the bill is finalized
    merged_into_order_id: uuid.UUID | None = None
    # "cancelled" | "merged" for an order with status cancelled, null otherwise. A merged order (joined into another) is NOT a
    # cancellation: `merged_into_number` is the order number the apps show ("#615056" without the #), cancel_reason reads
    # "Merged into order #615056" (services/order_kinds.py).
    kind: Literal["cancelled", "merged"] | None = None
    merged_into_number: str | None = None
    # Lateness (additive): last change of the order, its kitchen tickets (oldest first) and the first / last send time.
    updated_at: datetime | None = None
    kots: list[OrderKotSummary] = []
    first_kot_at: datetime | None = None
    last_kot_at: datetime | None = None


class KitchenSummaryOut(BaseModel):
    """GET /orders/summary and GET /kot/summary (one shared query, services/kitchen.in_kitchen_summary)."""
    in_kitchen: int  # orders with at least one active ticket (not done / cancelled, inside the KOT-only display window)
    tickets: int  # the active tickets themselves
    kitchen_status_mode: KitchenStatusMode
    kitchen_display_minutes: int


class OrdersSummaryOut(KitchenSummaryOut):
    """GET /orders/summary: the kitchen figure plus the cancelled / merged counts of the asked days (default today)."""
    cancelled: int = 0  # real cancellations (shared definition: services/order_kinds.cancelled_orders, same as the reports)
    merged: int = 0  # orders joined into another order: not cancellations


class KotOut(ORM):
    id: uuid.UUID
    order_id: uuid.UUID
    number: int
    status: KotStatus
    payload: list
    created_at: datetime | None = None  # sent to the kitchen
    updated_at: datetime | None = None  # last status change (e.g. when it was marked ready)
    done_at: datetime | None = None  # the kitchen tapped Done (KOT-only mode) or the ticket was served; null = still open
    order_created_at: datetime | None = None  # when the order was taken (lateness counts from here or from created_at)
    table_id: uuid.UUID | None = None   # of the order, when the KOT is listed through the API
    token_number: int | None = None
    order_note: str | None = None
    # Kitchen slip outcome (POST /orders/{id}/kot, GET /orders/{id}/print-status): {status: no_printer | queued | sent |
    # printed | failed, message, error?, needs_reprint, unrouted_items, hub_online}. Null on list endpoints.
    print: dict | None = None
    needs_reprint: bool = False


class KotStatusIn(BaseModel):
    status: KotStatus


class BillLineOut(ORM):
    id: uuid.UUID | None = None
    description: str
    quantity: int
    unit_price: Decimal
    line_total: Decimal  # amount shown on the receipt line before any discount (gross if prices include tax)
    item_id: uuid.UUID | None = None
    # After the line's share of the discount. Null on bills finalized before the per-line tax snapshot (then net = line_total).
    tax_code: str | None = None
    tax_rate_percent: Decimal | None = None
    net_amount: Decimal | None = None
    vat_amount: Decimal | None = None
    gross_amount: Decimal | None = None
    modifiers: list[dict] | None = None  # snapshot of the order line's modifiers (also folded into description)
    hsn: str | None = None  # India GST
    cgst_amount: Decimal | None = None
    sgst_amount: Decimal | None = None
    igst_amount: Decimal | None = None


class TaxBreakdownRow(BaseModel):
    code: str
    rate_percent: Decimal
    net: Decimal
    vat: Decimal
    gross: Decimal
    cgst: Decimal | None = None  # India GST rows only
    sgst: Decimal | None = None
    igst: Decimal | None = None

    @model_serializer(mode="wrap")
    def _omit_gst_split_when_absent(self, handler):  # non-India rows keep their original shape (code, rate, net, vat, gross)
        d = handler(self)
        for k in ("cgst", "sgst", "igst"):
            if d.get(k) is None:
                d.pop(k, None)
        return d


class DiscountIn(BaseModel):
    """A bill discount: percent or a flat amount, with an OPTIONAL reason (empty = none given; otherwise 3-200 characters)."""
    type: Literal["percent", "amount"]
    value: Decimal = Field(gt=0, max_digits=12, decimal_places=2)
    reason: str = Field(default="", max_length=200)

    @field_validator("reason", mode="before")
    @classmethod
    def _strip(cls, v):
        v = " ".join(str(v).split()) if v is not None else ""
        if v and not 3 <= len(v) <= 200:
            raise ValueError("reason must be 3-200 characters (or leave it empty)")
        return v


class PreviewLineOut(BaseModel):
    description: str
    quantity: int
    unit_price: Decimal
    line_total: Decimal   # shown amount before discount (gross if prices include tax, else net)
    discount: Decimal     # this line's share of the bill discount
    gross: Decimal        # after discount
    net: Decimal
    vat: Decimal
    tax_code: str
    rate_percent: Decimal


class AppliedOfferOut(BaseModel):
    offer_id: uuid.UUID
    name: str
    label: str      # what the bill prints, e.g. 'Offer: Lunch 10%'
    amount: Decimal  # this offer's part of discount_amount


class BillPreviewOut(BaseModel):
    lines: list[PreviewLineOut]
    discount_amount: Decimal  # TOTAL discount: offers + the manual discount
    discount_reason: str | None
    offers: list[AppliedOfferOut] = []  # automatic offers applied (empty when none is configured / applies)
    offer_amount: Decimal = Decimal("0")
    service_charge_amount: Decimal
    service_charge_percent: Decimal
    service_charge: PreviewLineOut | None
    subtotal: Decimal  # total excl. tax
    tax_amount: Decimal
    total: Decimal     # payable
    tax_breakdown: list[TaxBreakdownRow]
    currency: str
    prices_include_tax: bool
    vat_registered: bool
    round_off: Decimal = Decimal("0")  # India GST only: total = subtotal + tax_amount + round_off
    place_of_supply: str | None = None
    document_type: str | None = None
    country: str


class BillRequestIn(BaseModel):
    """Optional body of bill / bill-preview. service_charge=false removes the service charge from this bill only."""
    discount: DiscountIn | None = None
    service_charge: bool = True
    apply_offers: bool = True  # false = bill without the automatic offers (audited when one would have applied)
    # docs/ORDER_RULES.md. Owners / managers (bills.skip_kitchen) may bill a dine-in order before every item went to the
    # kitchen by giving a reason (audited); without it the bill is a 409 kitchen_ticket_required.
    skip_kitchen_reason: str | None = Field(default=None, max_length=200)
    # When the order already has an unpaid bill made with a DIFFERENT discount / service charge, the request is a 409
    # bill_already_exists; replace_existing=true (bills.discount, no payment taken yet) corrects it in one step
    # (credit note + replacement bill), with replace_reason (3-300 characters) for the audit.
    replace_existing: bool = False
    replace_reason: str | None = Field(default=None, max_length=300)


class BillDiscountIn(BaseModel):
    """Body of POST /bills/{id}/discount and /discount-preview: the discount an OPEN bill (made, nothing paid yet) should carry.
    `discount: null` removes it. `service_charge` omitted = as on the bill."""
    discount: DiscountIn | None = None
    service_charge: bool | None = None
    reason: str | None = Field(default=None, max_length=300)


class PaymentIn(BaseModel):
    idempotency_key: uuid.UUID
    method: PaymentMethod
    amount: Decimal = Field(gt=0, max_digits=12, decimal_places=2)


class PaymentOut(ORM):
    id: uuid.UUID
    method: PaymentMethod
    amount: Decimal


class RefundIn(BaseModel):
    idempotency_key: uuid.UUID
    amount: Decimal = Field(gt=0, max_digits=12, decimal_places=2)
    reason: str = Field(min_length=3, max_length=300)


class RefundOut(ORM):
    id: uuid.UUID
    credit_note_number: str
    amount: Decimal
    tax_amount: Decimal
    round_off: Decimal = Decimal("0")
    reason: str
    kind: str = "refund"   # "amendment" = the credit note that cancels a corrected bill, "void" = a voided bill's (not partial refunds)
    payout_amount: Decimal = Decimal("0")
    payout_method: str | None = None


class BillOut(ORM):
    id: uuid.UUID
    order_id: uuid.UUID
    invoice_number: str
    seller_name: str
    seller_trn: str | None
    currency: str
    tax_name: str
    tax_rate_percent: Decimal
    subtotal: Decimal
    tax_amount: Decimal
    total: Decimal
    country: str = "IN"
    prices_include_tax: bool = False
    vat_registered: bool = True
    discount_amount: Decimal = Decimal("0")
    discount_reason: str | None = None
    offer_amount: Decimal = Decimal("0")  # part of discount_amount that came from automatic offers
    offers: dict | None = None  # {"applied": [{offer_id, name, label, amount}], "manual_amount", "manual_reason"}; null = none
    service_charge_amount: Decimal = Decimal("0")
    service_charge_percent: Decimal = Decimal("0")
    tax_breakdown: list[TaxBreakdownRow] | None = None  # null on bills finalized before the tax breakdown existed
    # India GST (tax_mode 'gst_engine'); defaults elsewhere. total = subtotal + tax_amount + round_off.
    tax_mode: str = "off"
    document_type: str = "tax_invoice"
    seller_gstin: str | None = None
    customer_gstin: str | None = None
    customer_state_code: str | None = None
    place_of_supply: str | None = None
    cgst_amount: Decimal = Decimal("0")
    sgst_amount: Decimal = Decimal("0")
    igst_amount: Decimal = Decimal("0")
    round_off: Decimal = Decimal("0")
    packaging_amount: Decimal = Decimal("0")
    delivery_amount: Decimal = Decimal("0")
    lines: list[BillLineOut]
    payments: list[PaymentOut]
    refunds: list[RefundOut]
    customer_name: str | None = None
    customer_phone: str | None = None
    table_label: str | None = None
    order_type: str | None = None
    cashier_name: str | None = None
    paid: Decimal = Decimal("0")
    balance_due: Decimal = Decimal("0")
    # Amendments (see services/amend.py). sale_at = the sale's own date/time (kept by replacements);
    # finalized_at = when this record was posted.
    status: str = "active"
    sale_at: datetime | None = None
    finalized_at: datetime | None = None
    amended_at: datetime | None = None
    amend_reason: str | None = None
    voided_at: datetime | None = None
    void_reason: str | None = None
    superseded_by: uuid.UUID | None = None
    superseded_by_number: str | None = None
    amends: uuid.UUID | None = Field(default=None, validation_alias="amends_bill_id")
    amends_number: str | None = None
    amends_credit_note: str | None = None
    amendment_chain: list[uuid.UUID] = []


class OrderCustomerIn(BaseModel):
    customer_id: uuid.UUID | None


class OrderCancelIn(BaseModel):
    reason: str = Field(min_length=3, max_length=300)

    @field_validator("reason")
    @classmethod
    def _strip(cls, v: str) -> str:
        v = v.strip()
        if len(v) < 3:
            raise ValueError("reason must be at least 3 characters")
        return v


class ResetPasswordIn(BaseModel):
    new_password: str = Field(min_length=10, max_length=256)

    @field_validator("new_password")
    @classmethod
    def _password_policy(cls, v: str) -> str:  # security review finding 7 (the service adds the email / name check)
        return password_policy.validate(v)



class ForgotPasswordIn(BaseModel):
    email: EmailStr
    restaurant_id: uuid.UUID | None = None  # optional: only that restaurant's account
    restaurant_code: str | None = Field(default=None, max_length=16)  # optional, same effect (staff know the code, not the id)
    locale: str | None = Field(default=None, max_length=10)  # en | hi (else Accept-Language, else en)


class ResetWithTokenIn(BaseModel):
    restaurant_id: uuid.UUID  # the `r` of the emailed link
    token: str = Field(min_length=20, max_length=100)  # the `t` of the emailed link
    new_password: str = Field(min_length=10, max_length=256)
    locale: str | None = Field(default=None, max_length=10)

    @field_validator("new_password")
    @classmethod
    def _password_policy(cls, v: str) -> str:  # security review finding 7 (the service adds the email / name check)
        return password_policy.validate(v)



class CommsSettingsIn(BaseModel):
    """Owner-editable communication switches (both default off). Omitted fields stay unchanged."""
    whatsapp_enabled: bool | None = None
    login_alert_emails: bool | None = None


class CommsSettingsOut(BaseModel):
    whatsapp_enabled: bool
    login_alert_emails: bool
    whatsapp_available: bool  # a WhatsApp provider is configured on this server
    email_available: bool


class WhatsAppSendIn(BaseModel):
    phone: str | None = Field(default=None, max_length=30)  # default: the bill's customer phone
    language: str = Field(default="en", pattern="^(en|hi)$")  # template language


class WhatsAppOutboxOut(ORM):
    id: uuid.UUID
    kind: str
    mode: str
    to_phone: str
    template: str | None = None
    status: str
    attempts: int
    next_attempt_at: datetime
    last_error: str | None = None
    sent_at: datetime | None = None
    bill_id: uuid.UUID | None = None
    created_at: datetime


class ChangePasswordIn(BaseModel):
    current_password: str
    new_password: str = Field(min_length=10, max_length=256)

    @field_validator("new_password")
    @classmethod
    def _password_policy(cls, v: str) -> str:  # security review finding 7 (the service adds the email / name check)
        return password_policy.validate(v)



class OutletIn(BaseModel):
    """A new outlet. `code` and `invoice_prefix` (A-Z, 0-9, upper-cased) are fixed once created."""
    name: str = Field(min_length=1, max_length=200)
    code: str = Field(min_length=1, max_length=10)
    invoice_prefix: str = Field(min_length=1, max_length=10)
    address: str | None = Field(default=None, max_length=500)
    phone: str | None = Field(default=None, max_length=30)
    trn: str | None = Field(default=None, max_length=20)  # the outlet's GSTIN (optional)
    timezone: str | None = Field(default=None, max_length=64)
    country: CountryCode | None = None  # IN only (422 otherwise)
    currency: CurrencyCode | None = None  # INR only (422 otherwise)

    @field_validator("code", "invoice_prefix")
    @classmethod
    def _upper_alnum(cls, v: str) -> str:
        v = v.strip().upper()
        if not re.fullmatch(r"[A-Z0-9]{1,10}", v):
            raise ValueError("use letters and digits only (A-Z, 0-9)")
        return v


class OutletPatch(BaseModel):
    """Only the sent fields change. Code and invoice prefix cannot be changed."""
    model_config = ConfigDict(extra="forbid")
    name: str | None = Field(default=None, min_length=1, max_length=200)
    address: str | None = Field(default=None, max_length=500)
    phone: str | None = Field(default=None, max_length=30)
    trn: str | None = Field(default=None, max_length=20)  # the outlet's GSTIN
    timezone: str | None = Field(default=None, max_length=64)
    is_active: bool | None = None
    country: CountryCode | None = None  # IN only (422 otherwise); no effect
    currency: CurrencyCode | None = None  # INR only (422 otherwise); no effect


class OutletOut(ORM):
    id: uuid.UUID
    name: str
    code: str
    invoice_prefix: str
    is_default: bool
    is_active: bool
    address: str | None = None
    phone: str | None = None
    trn: str | None = None
    currency: str
    timezone: str
    country: str

    @computed_field  # display text of `timezone`, e.g. "India (IST)"
    @property
    def timezone_label(self) -> str:
        from app.services.localisation import timezone_label
        return timezone_label(self.timezone)


class MeOut(UserOut):
    restaurant_name: str | None = None
    restaurant_code: str | None = None  # the code staff type at sign-in (also on their staff card)
    outlet_id: uuid.UUID | None = None
    outlets: list[OutletOut] = []
    # The restaurant's money / locale facts (every amount of this restaurant is in `currency`; India: INR, "₹", Asia/Kolkata).
    country: str | None = None
    currency: str | None = None
    currency_symbol: str | None = None
    timezone: str | None = None

    @computed_field  # display text of `timezone`, e.g. "India (IST)" (null timezone: "")
    @property
    def timezone_label(self) -> str:
        from app.services.localisation import timezone_label
        return timezone_label(self.timezone)

    tax_word: str | None = None
    business_types: list[str] = ["restaurant"]  # docs/BUSINESS_TYPES.md
    capabilities: dict | None = None  # what the UI may show: dine_in, tables, reservations, order_types, ...
    features: dict[str, bool] | None = None  # code -> available (granted by super admin and switched on by the owner)
    kitchen_target_minutes: int | None = None  # the restaurant's kitchen lateness target (minutes), for KDS / order colours
    # Order rules the UI follows (docs/ORDER_RULES.md): {require_kot_before_bill: bool, kitchen_status_mode: "kot_only" | "track", kitchen_display_minutes: int}.
    order_rules: dict | None = None
    permissions: list[str] = []  # effective permissions (app/core/permissions.py): UIs gate on these, not on role names
    # Entitlements (docs/ENTITLEMENTS.md): null while ENTITLEMENTS_ENFORCE=off. `entitlement_warning` is past_due /
    # entitlements_stale / suspended (warn mode): show a banner. `read_only` is true when writes will be refused.
    entitlements: dict | None = None
    entitlement_warning: str | None = None
    read_only: bool = False
    support_access: dict | None = None  # set for a platform support session: {staff_id, grant_id, scope}
    # PAYG wallet block (docs/PAYG_BILLING.md): state trial|active|low|empty|suspended, trial_ends_at, days_left, balance_paise,
    # per_bill_paise, can_bill, banner {level, code, message {en, hi}}, ... null when platform-core is not configured / unknown.
    billing: dict | None = None
    # set for a counter PIN session (docs/STAFF_PIN_DEVICES_API.md): {kind: "pin", session_id, counter_device_id, outlet_id,
    # expires_at, idle_expires_at}; null for a password session
    session: dict | None = None


class OutletAccessIn(BaseModel):
    outlet_ids: list[uuid.UUID] = Field(default_factory=list, max_length=200)


class OutletAccessOut(BaseModel):
    outlet_ids: list[uuid.UUID]


class BusinessTypesIn(BaseModel):
    """PUT /restaurant/business-types (owner). Replaces the selection; 409 open_orders_block_business_type_change while any
    order is open. Removing a type hides its features, it never deletes data."""
    business_types: BusinessTypes
    reason: str | None = Field(default=None, max_length=300)


class FeatureAccessOut(BaseModel):
    """One controllable feature for Manage > Features: `granted` = super admin allows it, `switched_on` = the owner's switch,
    `available` = both."""
    code: str
    label: str
    group: str
    group_label: str
    description: str
    granted: bool
    switched_on: bool
    available: bool


class FeaturesIn(BaseModel):
    """Owner: {"features": {"order.takeaway": false, "reports": true}}. Only codes from GET /restaurant/features."""
    features: dict[str, bool]
