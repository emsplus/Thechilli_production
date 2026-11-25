"""Device sessions, counter devices, staff PINs, step-up (docs/STAFF_PIN_DEVICES_API.md)."""
import uuid

import jwt
from fastapi import APIRouter, Body, Depends, Header, HTTPException, Request, Response
from fastapi.security import HTTPAuthorizationCredentials
from sqlalchemy.orm import Session

from app.api import deps
from app.api.deps import P, Principal, current_principal, require_perm
from app.api.v1 import menu as menu_api
from app.core.config import settings
from app.core.db import get_db
from app.schemas.common import CategoryOut, ItemOut, TableOut
from app.schemas.devices import (
    CounterDeviceCreated, CounterDeviceIn, CounterDeviceOut, LoginDeviceOut, OwnPinIn, PinIn, PinLoginIn, PinLoginOut,
    PinLogoutIn, PinStatusOut, RosterOut, SignOutAllIn, SignOutAllOut, StepUpIn, StepUpOut,
)
from app.services import devices, staff_pin

auth_router = APIRouter(prefix="/auth", tags=["auth"])
devices_router = APIRouter(prefix="/devices", tags=["devices"])


# ------------------------------------------------------------------------------------------------ signed-in devices
@auth_router.get("/devices", response_model=list[LoginDeviceOut])
def list_devices(request: Request, all: bool = False, user_id: uuid.UUID | None = None,
                 p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """The caller's signed-in devices, most recent first. `all=true` (every user) or `user_id` (someone else) need
    devices.manage. `current` marks the device of this request (X-Device-Id)."""
    return devices.list_devices(db, p, everyone=all, user_id=user_id, current_key=request.headers.get("x-device-id"))


@auth_router.delete("/devices/{device_id}", status_code=204)
def revoke_device(device_id: uuid.UUID, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """Signs that device out now: its refresh tokens are revoked (the next /auth/refresh is a 401). Own devices, or anyone's
    with devices.manage (an owner's only by an owner)."""
    devices.revoke(db, p, device_id)
    return Response(status_code=204)


@auth_router.post("/devices/sign-out-all", response_model=SignOutAllOut)
def sign_out_everywhere(request: Request, data: SignOutAllIn | None = Body(default=None),
                        p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """'Sign out everywhere': every refresh token of the caller is revoked and their counter PIN sessions end.
    `keep_current: true` keeps the device of this request (X-Device-Id) signed in."""
    data = data or SignOutAllIn()
    n = devices.sign_out_all(db, p, p.user_id, request.headers.get("x-device-id") if data.keep_current else None)
    return SignOutAllOut(devices_signed_out=n)


@auth_router.post("/users/{user_id}/sign-out-all", response_model=SignOutAllOut)
def sign_out_user_everywhere(user_id: uuid.UUID, p: Principal = Depends(require_perm(P.DEVICES_MANAGE)),
                             db: Session = Depends(get_db)):
    """Owner / manager: signs a staff member out of every device and ends their PIN sessions (a lost phone)."""
    return SignOutAllOut(devices_signed_out=devices.sign_out_all(db, p, user_id))


# ------------------------------------------------------------------------------------------------ own PIN
@auth_router.get("/me/pin", response_model=PinStatusOut)
def my_pin(p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    return staff_pin.status(db, p.user_id)


@auth_router.put("/me/pin", status_code=204)
def set_my_pin(data: OwnPinIn, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """Set / change the caller's counter PIN (4-6 digits). Needs a PASSWORD session and the current password."""
    staff_pin.set_own(db, p, data.pin.get_secret_value(), data.current_password.get_secret_value())
    return Response(status_code=204)


@auth_router.delete("/me/pin", status_code=204)
def clear_my_pin(p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    staff_pin.clear_own(db, p)
    return Response(status_code=204)


# ------------------------------------------------------------------------------------------------ manager PIN admin
@auth_router.put("/users/{user_id}/pin", status_code=204)
def reset_user_pin(user_id: uuid.UUID, data: PinIn, p: Principal = Depends(require_perm(P.STAFF_PIN_MANAGE)),
                   db: Session = Depends(get_db)):
    """Owner / manager: set a staff member's PIN (they are asked to choose their own). Clears lockouts, ends their PIN sessions."""
    staff_pin.set_for(db, p, user_id, data.pin.get_secret_value())
    return Response(status_code=204)


@auth_router.delete("/users/{user_id}/pin", status_code=204)
def clear_user_pin(user_id: uuid.UUID, p: Principal = Depends(require_perm(P.STAFF_PIN_MANAGE)), db: Session = Depends(get_db)):
    staff_pin.clear_for(db, p, user_id)
    return Response(status_code=204)


@auth_router.post("/users/{user_id}/pin/unlock", status_code=204)
def unlock_user_pin(user_id: uuid.UUID, p: Principal = Depends(require_perm(P.STAFF_PIN_MANAGE)), db: Session = Depends(get_db)):
    """Owner / manager: lifts a wrong-PIN lockout (every device) without changing the PIN."""
    staff_pin.unlock(db, p, user_id)
    return Response(status_code=204)


# ------------------------------------------------------------------------------------------------ PIN sessions
@auth_router.post("/pin-login", response_model=PinLoginOut)
def pin_login(data: PinLoginIn, request: Request, x_counter_token: str | None = Header(default=None),
              db: Session = Depends(get_db)):
    """Counter device + staff id + PIN -> a short staff session (idle PIN_IDLE_MINUTES, at most PIN_SESSION_MAX_HOURS) with
    the user's role / permissions, confined to the device's outlet. 401 wrong PIN / bad device credential (header
    X-Pin-Attempts-Left), 429 locked or rate limited (Retry-After)."""
    token = data.device_token.get_secret_value() if data.device_token else x_counter_token
    return staff_pin.pin_login(db, token, data.user_id, data.pin.get_secret_value(), devices.client_ip(request))


@auth_router.post("/pin-logout", status_code=204)
def pin_logout(data: PinLogoutIn | None = Body(default=None), creds: HTTPAuthorizationCredentials | None = Depends(deps.bearer),
               db: Session = Depends(get_db)):
    """Ends the PIN session of the bearer token (tablet 'lock' / switch user / idle lock). Works with an idle or expired
    session token too; always 204 for a PIN session token, 400 for any other token."""
    if creds is None:
        raise HTTPException(401, "Not authenticated")
    try:
        claims = jwt.decode(creds.credentials, settings.jwt_secret, algorithms=[settings.jwt_algorithm],
                            issuer=settings.jwt_issuer, audience=settings.jwt_audience,
                            options={"verify_exp": False, "require": ["sub", "rid"]})
    except jwt.PyJWTError:
        raise HTTPException(401, "Invalid token")
    if "ps" not in claims:
        raise HTTPException(400, "Not a PIN session")
    try:
        staff_pin.pin_logout(db, claims, (data or PinLogoutIn()).reason)
    except (ValueError, TypeError):
        raise HTTPException(401, "Invalid token")
    return Response(status_code=204)


@auth_router.post("/step-up", response_model=StepUpOut)
def step_up(data: StepUpIn, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """Re-enter the PIN (or password) to get a 5-minute X-Step-Up-Token for sensitive actions (void, discount over the cap)
    when STEP_UP_REQUIRED is on. Same lockout rules as PIN sign-in."""
    return staff_pin.step_up(db, p, data.pin.get_secret_value() if data.pin else None,
                             data.password.get_secret_value() if data.password else None)


# ------------------------------------------------------------------------------------------------ counter devices (admin)
@devices_router.post("/counter", response_model=CounterDeviceCreated, status_code=201)
def register_counter(data: CounterDeviceIn, p: Principal = Depends(require_perm(P.DEVICES_MANAGE)), db: Session = Depends(get_db)):
    """Owner / manager: registers a shared counter tablet for an outlet. `device_token` is returned ONCE."""
    d, token = devices.register_counter(db, p, data.name, data.outlet_id)
    return CounterDeviceCreated(id=d.id, name=d.name, outlet_id=d.outlet_id, created_at=d.created_at, device_token=token)


@devices_router.get("/counter", response_model=list[CounterDeviceOut])
def list_counters(p: Principal = Depends(require_perm(P.DEVICES_MANAGE)), db: Session = Depends(get_db)):
    return devices.list_counters(db, p)


@devices_router.delete("/counter/{device_id}", status_code=204)
def revoke_counter(device_id: uuid.UUID, p: Principal = Depends(require_perm(P.DEVICES_MANAGE)), db: Session = Depends(get_db)):
    """Revokes the tablet's credential and ends every PIN session on it, at once (a stolen tablet)."""
    devices.revoke_counter(db, p, device_id)
    return Response(status_code=204)


# ------------------------------------------------------------------------------------------------ counter device (its own credential)
def counter_device(request: Request, x_counter_token: str | None = Header(default=None), db: Session = Depends(get_db)):
    return devices.authenticate_counter(db, x_counter_token, devices.client_ip(request))


@devices_router.get("/counter/roster", response_model=RosterOut)
def roster(d=Depends(counter_device), db: Session = Depends(get_db)):
    """X-Counter-Token. The device and the staff who can sign in on it (active, PIN set, allowed at its outlet)."""
    return devices.roster(db, d)


@devices_router.get("/counter/menu")
def counter_menu(d=Depends(counter_device), db: Session = Depends(get_db)) -> dict[str, list]:
    """X-Counter-Token. Active categories and items (same shapes as GET /menu/categories and /menu/items)."""
    dp = devices.device_principal(d)
    return {"categories": [CategoryOut.model_validate(c) for c in menu_api.list_categories(False, dp, db)],
            "items": [ItemOut.model_validate(i) for i in menu_api.list_items(None, False, dp, db)]}


@devices_router.get("/counter/tables", response_model=list[TableOut])
def counter_tables(d=Depends(counter_device), db: Session = Depends(get_db)):
    """X-Counter-Token. Active tables of the device's outlet (same shape as GET /tables)."""
    return menu_api.list_tables(False, None, devices.device_principal(d), db)
