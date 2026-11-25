import re
import uuid
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator


class _Strict(BaseModel):
    model_config = ConfigDict(extra="ignore")


class DCustomer(_Strict):
    name: str = Field(min_length=1, max_length=200)
    wa_number: str | None = Field(default=None, max_length=30)


class DAddress(_Strict):
    text: str = Field(min_length=1, max_length=500)
    lat: float | None = Field(default=None, ge=-90, le=90)
    lng: float | None = Field(default=None, ge=-180, le=180)


class DPayment(_Strict):
    mode: Literal["cod", "online"] = "cod"
    claimed_paid: bool = False  # a claim by the customer / channel; never treated as paid until staff confirm it
    ref: str | None = Field(default=None, max_length=100)


class DLine(_Strict):
    item_id: uuid.UUID
    variant_id: uuid.UUID | None = None
    quantity: int = Field(ge=1, le=99)
    note: str | None = Field(default="", max_length=300)
    expected_unit_price: int | None = Field(default=None, ge=0)  # minor units, as the customer saw it


class DeliveryOrderIn(_Strict):
    client_uuid: str | None = Field(default=None, max_length=128)
    channel: Literal["whatsapp", "web"] = "web"
    order_type: Literal["delivery"] = "delivery"
    customer: DCustomer
    address: DAddress
    payment: DPayment = DPayment()
    promo_code: str | None = Field(default=None, max_length=40)
    outlet_id: uuid.UUID | None = None
    lines: list[DLine] = Field(min_length=1, max_length=100)

    @field_validator("promo_code")
    @classmethod
    def _blank(cls, v):
        return v.strip() or None if isinstance(v, str) else v


class DeliveryCancelIn(_Strict):
    reason: str = Field(default="cancelled by delivery service", min_length=1, max_length=300)


class DeliverySettingsIn(BaseModel):
    enabled: bool | None = None
    accept_before_kot: bool | None = None
    delivery_fee: Decimal | None = Field(default=None, ge=0, max_digits=12, decimal_places=2)
    free_delivery_above: Decimal | None = Field(default=None, ge=0, max_digits=12, decimal_places=2)
    clear_free_delivery_above: bool = False
    min_order: Decimal | None = Field(default=None, ge=0, max_digits=12, decimal_places=2)
    radius_km: Decimal | None = Field(default=None, ge=0, max_digits=6, decimal_places=2)
    hours: dict[str, list[list[str]]] | None = None
    webhook_url: str | None = Field(default=None, max_length=500)
    rotate_webhook_secret: bool = False
    # Public ordering link (delivery-service owns the slug). Handling: app/services/public_link.py
    public_order_enabled: bool | None = None
    rotate_public_order_link: bool = False
    public_order_brand_color: str | None = Field(default=None, max_length=7)  # "#RRGGBB"; "" clears
    public_order_service_token: SecretStr | None = Field(default=None, max_length=500)  # write-only; "" clears; stored encrypted

    @field_validator("public_order_brand_color")
    @classmethod
    def _color(cls, v):
        if v is not None and v != "" and not re.fullmatch(r"#[0-9A-Fa-f]{6}", v):
            raise ValueError("Brand colour must look like #0B6E4F (a # and six letters or digits), or be empty to clear it.")
        return v
