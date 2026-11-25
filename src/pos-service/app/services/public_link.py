"""Per-restaurant public ordering link (docs/DELIVERY_API.md "Public ordering link").

delivery-service owns the slug and the page; pos-service keeps the owner's choice (`public_order_enabled`), a cache of the last URL
(`public_order_url`) and, per tenant, the encrypted token it calls delivery-service with. Every call has a short timeout and is
never allowed to break the settings screen. The token is never logged, never returned and never put in an error message.
"""
from __future__ import annotations

import logging
import re
import uuid
from typing import Protocol

import httpx
from sqlalchemy.orm import Session

from app.core import secretbox
from app.core.config import settings
from app.models.core import DeliverySettings

log = logging.getLogger("app.delivery.public_link")

COLOR_RE = re.compile(r"^#[0-9A-Fa-f]{6}$")


class LinkMissing(Exception):
    """delivery-service answered 404: no link yet (or the restaurant is not configured there)."""


class LinkUnavailable(Exception):
    """Network error, timeout, 5xx, or any answer that is not a usable 2xx / 404."""


class LinkClient(Protocol):
    """Every method returns delivery-service's link JSON {enabled, slug, url, brand_color, ...} or raises LinkMissing / LinkUnavailable."""

    def get(self, rid: str, token: str) -> dict: ...
    def ensure(self, rid: str, token: str, brand_color: str | None = None) -> dict: ...
    def enable(self, rid: str, token: str) -> dict: ...
    def disable(self, rid: str, token: str) -> dict: ...
    def rotate(self, rid: str, token: str) -> dict: ...
    def set_brand_color(self, rid: str, token: str, brand_color: str) -> dict: ...


class HttpLinkClient:
    """The real client (httpx). `transport` is for tests that want a wire-level fake; no redirects are followed."""

    def __init__(self, base_url: str, timeout: float = 2.0, transport: httpx.BaseTransport | None = None):
        self.base = base_url.rstrip("/")
        self.timeout = timeout
        self.transport = transport

    def _call(self, method: str, rid: str, token: str, suffix: str = "", json: dict | None = None) -> dict:
        url = f"{self.base}/api/v1/restaurants/{rid}/public-link{suffix}"
        try:
            with httpx.Client(timeout=self.timeout, transport=self.transport, follow_redirects=False) as c:
                r = c.request(method, url, json=json, headers={"Authorization": f"Bearer {token}"})
        except httpx.HTTPError as e:
            log.warning("delivery-service public-link %s failed: %s", method, type(e).__name__)  # class only: never the URL or headers
            raise LinkUnavailable(type(e).__name__) from None
        if r.status_code == 404:
            raise LinkMissing()
        if not 200 <= r.status_code < 300:
            log.warning("delivery-service public-link %s answered %s", method, r.status_code)
            raise LinkUnavailable(f"status {r.status_code}")
        try:
            body = r.json()
        except ValueError:
            raise LinkUnavailable("bad body") from None
        if not isinstance(body, dict):
            raise LinkUnavailable("bad body")
        return body

    def get(self, rid, token):
        return self._call("GET", rid, token)

    def ensure(self, rid, token, brand_color=None):
        return self._call("POST", rid, token, json={"brand_color": brand_color} if brand_color is not None else {})

    def enable(self, rid, token):
        return self._call("POST", rid, token, "/enable")

    def disable(self, rid, token):
        return self._call("POST", rid, token, "/disable")

    def rotate(self, rid, token):
        return self._call("POST", rid, token, "/rotate")

    def set_brand_color(self, rid, token, brand_color):
        return self._call("PATCH", rid, token, json={"brand_color": brand_color})


# Tests install a fake here (tests/public_link_fake.py); None = the real client when DELIVERY_SERVICE_URL is set.
client_override: LinkClient | None = None


def get_client() -> LinkClient | None:
    if client_override is not None:
        return client_override
    if settings.delivery_service_url.strip():
        return HttpLinkClient(settings.delivery_service_url, settings.public_link_timeout_seconds)
    return None


def token_for(cfg: DeliverySettings) -> str | None:
    """The tenant's own token (decrypted), else the single-tenant env fallback, else None."""
    if cfg.service_token_enc:
        try:
            return secretbox.decrypt(cfg.service_token_enc)
        except secretbox.SecretBoxError:
            log.error("delivery token of %s cannot be decrypted", cfg.restaurant_id)
            return None
    return settings.delivery_service_token.get_secret_value() or None


def set_token(cfg: DeliverySettings, token: str) -> None:
    cfg.service_token_enc = secretbox.encrypt(token) if token else None


def connection(cfg: DeliverySettings) -> tuple[LinkClient, str] | None:
    c, t = get_client(), token_for(cfg)
    return (c, t) if c is not None and t else None


def refresh(db: Session, cfg: DeliverySettings) -> str | None:
    """`public_order_url` for GET /delivery/settings. Only when the owner switched the link on: ask delivery-service; give the URL
    only for an enabled link; 404 / disabled -> None; an error -> the cached URL (the settings call never fails because of it)."""
    if not cfg.public_order_enabled:
        return None
    conn = connection(cfg)
    if conn is None:
        return None  # not connected
    client, token = conn
    rid = str(cfg.restaurant_id)
    try:
        link = client.get(rid, token)
    except LinkMissing:
        _cache(db, cfg, None)
        return None
    except LinkUnavailable:
        return cfg.public_order_url
    url = link.get("url") if link.get("enabled") else None
    _cache(db, cfg, url if isinstance(url, str) and url else None)
    return cfg.public_order_url


def _cache(db: Session, cfg: DeliverySettings, url: str | None) -> None:
    if cfg.public_order_url != url:
        cfg.public_order_url = url
        db.commit()


def new_cfg(rid: uuid.UUID) -> DeliverySettings:
    return DeliverySettings(restaurant_id=rid, enabled=False, accept_before_kot=False, delivery_fee=0, min_order=0,
                            public_order_enabled=False)


# ---------------------------------------------------------------------------------------------- PUT /delivery/settings
NOT_CONNECTED = ("The online ordering link is not connected yet, so it could not be changed. Your other settings were saved. "
                 "Please try again in a minute or contact support.")
UNAVAILABLE = ("We could not reach the online ordering service, so the link was not changed. Your other settings were saved. "
               "Please try again in a minute.")
NOT_KNOWN = ("The online ordering service does not know this restaurant yet, so the link was not changed. "
             "Your other settings were saved. Please contact support.")
LINK_OFF = "Turn the online ordering link on first, then you can make a new link or change its colour."


def _url(link: dict) -> str | None:
    u = link.get("url")
    return u if isinstance(u, str) and u else None


def apply(db: Session, p, cfg: DeliverySettings, *, enable: bool | None, rotate: bool, brand_color: str | None) -> None:
    """Runs the link part of a settings update against delivery-service, one committed stage at a time (enable/disable, then the
    colour, then rotate), so what pos-service stores always matches what delivery-service did. Raises DeliveryError: 409
    `public_order_link_off` for a rotate / colour while the link is off, 502 `delivery_service_unavailable` when delivery-service
    cannot be reached or refuses (public_order_enabled is then NOT flipped for that stage)."""
    from app.services import audit
    from app.services.delivery import DeliveryError

    target = cfg.public_order_enabled if enable is None else enable
    if (rotate or brand_color is not None) and not target:
        raise DeliveryError(409, "public_order_link_off", LINK_OFF)
    conn = connection(cfg)
    if conn is None:
        raise DeliveryError(502, "delivery_service_unavailable", NOT_CONNECTED)
    client, token = conn
    rid = str(cfg.restaurant_id)

    def stage(fn, *args):
        try:
            return fn(rid, token, *args)
        except LinkMissing:
            raise DeliveryError(502, "delivery_service_unavailable", NOT_KNOWN) from None
        except LinkUnavailable:
            raise DeliveryError(502, "delivery_service_unavailable", UNAVAILABLE) from None

    if enable is True:
        link = stage(client.ensure, brand_color or None)
        if not link.get("enabled"):
            link = stage(client.enable)
        cfg.public_order_enabled, cfg.public_order_url = True, _url(link)
        audit.record(db, p, "delivery.public_link.enable", "restaurant", p.restaurant_id)
        db.commit()
    elif enable is False:
        try:
            client.disable(rid, token)
        except LinkMissing:
            pass  # there was never a link: already off
        except LinkUnavailable:
            raise DeliveryError(502, "delivery_service_unavailable", UNAVAILABLE) from None
        cfg.public_order_enabled, cfg.public_order_url = False, None
        audit.record(db, p, "delivery.public_link.disable", "restaurant", p.restaurant_id)
        db.commit()
    if brand_color is not None:
        link = stage(client.set_brand_color, brand_color)
        cfg.public_order_url = _url(link) if link.get("enabled") else cfg.public_order_url
        audit.record(db, p, "delivery.public_link.brand_color", "restaurant", p.restaurant_id, {"brand_color": brand_color or None})
        db.commit()
    if rotate:
        link = stage(client.rotate)
        cfg.public_order_url = _url(link) if link.get("enabled") else None
        audit.record(db, p, "delivery.public_link.rotate", "restaurant", p.restaurant_id)
        db.commit()
