import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class RestaurantIn(BaseModel):
    brand_name: str = Field(max_length=120)
    payment_qr_url: str | None = None
    pos_webhook_secret_ref: str
    pos_api_key_ref: str


class ChannelIn(BaseModel):
    phone_number_id: str = Field(min_length=1, max_length=64)
    display_number: str = ""


class RiderIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    phone: str = Field(min_length=5, max_length=32)
    role: str = Field(default="rider", pattern="^(rider|manager)$")
    outlet_id: str | None = None


class RiderPatch(BaseModel):
    name: str | None = None
    active: bool | None = None


class RiderOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    name: str
    phone: str
    role: str
    active: bool


class OrderOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    pos_order_id: str
    order_code: str
    status: str
    customer_name: str
    wa_number: str
    address_text: str
    subtotal: int
    delivery_fee: int
    tax: int
    total: int
    payment_mode: str
    claimed_paid: bool
    payment_confirmed: bool
    rider_id: uuid.UUID | None
    offered_rider_id: uuid.UUID | None
    otp_locked: bool
    created_at: datetime


class AssignIn(BaseModel):
    rider_id: uuid.UUID | None = None  # omitted = auto-assign


class RevokeIn(BaseModel):
    token: str = Field(min_length=10, max_length=2000)
    aud: str = Field(pattern="^(svc|menu|track|rider)$")
    reason: str = Field(default="", max_length=200)


class ReasonIn(BaseModel):
    reason: str = Field(min_length=3, max_length=300)


class MenuLinkIn(BaseModel):
    wa_number: str = Field(min_length=5, max_length=32)


class LineIn(BaseModel):
    item_id: str
    variant_id: str | None = None
    quantity: int = Field(ge=1, le=50)
    note: str = Field(default="", max_length=200)


class AddressIn(BaseModel):
    text: str = Field(min_length=3, max_length=500)
    lat: float | None = Field(default=None, ge=-90, le=90)
    lng: float | None = Field(default=None, ge=-180, le=180)


class WebOrderIn(BaseModel):
    client_uuid: str = Field(min_length=8, max_length=64)
    name: str = Field(min_length=1, max_length=120)
    address: AddressIn
    payment_mode: str = Field(default="cod", pattern="^(cod|online)$")
    claimed_paid: bool = False
    promo_code: str | None = None
    lines: list[LineIn] = Field(min_length=1, max_length=60)


class OtpIn(BaseModel):
    otp: str = Field(min_length=4, max_length=10)


class PingIn(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)


class PublicOrderIn(WebOrderIn):
    """Order from the public restaurant link: no signed customer link exists, so the phone number comes in the body. The idempotency key
    is longer than for signed links because anyone who guesses a key could otherwise read someone else's order back."""
    client_uuid: str = Field(min_length=16, max_length=64)
    phone: str = Field(min_length=8, max_length=32)


class PublicLinkPatch(BaseModel):
    brand_color: str | None = Field(default=None, max_length=7)  # "#RRGGBB"; "" or null clears it
    enabled: bool | None = None


class PublicLinkIn(BaseModel):
    brand_color: str | None = Field(default=None, max_length=7)
