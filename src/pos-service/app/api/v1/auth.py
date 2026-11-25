import hashlib
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import current_principal, P, Principal, require_perm
from app.core.config import self_register_allowed, settings
from app.core.db import get_db
from app.core.security import hash_password
from app.core.tenancy import bind_tenant
from app.models.core import Restaurant, Role, User
from app.schemas.common import (
    ChangePasswordIn, ForgotPasswordIn, LoginIn, ResetWithTokenIn, MeOut, OutletAccessIn, OutletAccessOut, OutletOut, RefreshIn, RegisterRestaurantIn, ResetPasswordIn, StaffCreatedOut, StaffInviteOut, StaffOut, TemporaryPasswordOut, TokenOut, UserCreate, UserOut, UserPatch,
)
from app.services import abuse, account_mail, account_otp, accounts, mfa, audit, business_type, comms_templates, devices, entitlements, feature_access, localisation as L, manage, outlets, staff_accounts, tokens, wallet

from datetime import timedelta

router = APIRouter(prefix="/auth", tags=["auth"])
REGISTER_EMAIL_IN_USE = ("This email cannot be used to register a new restaurant. If it is yours, sign in instead, or register "
                         "with the same password as your existing account to add another restaurant.")


def _device(request: Request, label: str | None = None) -> str | None:
    return label or request.headers.get("user-agent")


@router.post("/register-restaurant", response_model=TokenOut, status_code=201)
def register_restaurant(data: RegisterRestaurantIn, request: Request, db: Session = Depends(get_db)):
    """Bootstrap a tenant with its owner and India's tax rules: country IN, INR, Asia/Kolkata; the GSTIN (`trn`) is optional
and validated when given. `country` may be omitted; any value but IN is a 422.
`business_types` (one or more of restaurant | cloud_kitchen | hotel_kitchen, default ["restaurant"]) sets what the business
may use (docs/BUSINESS_TYPES.md)."""
    if not self_register_allowed(settings):  # production: sign-up goes through platform-core onboarding (one workflow)
        e = HTTPException(403, "Sign up on the TheChilli.ai website: restaurants are created by the onboarding workflow.")
        e.code, e.details = "self_register_disabled", {"signup_url": settings.signup_url or None}
        raise e
    # Anyone on the internet can call this: per-IP and global limits (DB-backed, so they hold across workers; every call counts).
    ip = request.client.host if request.client else "unknown"  # X-Forwarded-For only counts if uvicorn trusts the proxy (FORWARDED_ALLOW_IPS)
    abuse.throttle([(f"register:ip:{ip}", settings.register_per_ip_per_hour), ("register:global", settings.register_global_per_hour)],
                   window=timedelta(hours=1), what="sign-ups")
    # Security review finding 1: an email that already has an account (in ANY restaurant) cannot be claimed by a new tenant.
    # The one exception is its holder adding another restaurant: proven by registering with that account's own password.
    # Anyone else gets the same 409 (the existing holder is told by email), and the miss counts against that email's login
    # budget so registration is no password oracle.
    if accounts.candidates(db, data.owner_email):
        key = accounts.throttle_key(data.owner_email)
        if accounts.retry_after(db, key, ip) or not accounts.password_matches(db, data.owner_email, data.owner_password):
            accounts.record_failure(db, key, ip)
            account_mail.notify_register_attempt(data.owner_email, comms_templates.pick_locale(request.headers.get("accept-language")))
            raise HTTPException(409, REGISTER_EMAIL_IN_USE)
    db.rollback()  # the lookup above ran unbound; the new tenant is bound on a fresh transaction
    if settings.signup_email_verification:  # owner decision: the email is proven first (docs/EMAIL.md); 202, no session
        return account_otp.start_signup(db, data, request)
    return create_restaurant(data, request, db)


def create_restaurant(data: RegisterRestaurantIn, request: Request, db: Session, password_hash: str | None = None) -> TokenOut:
    """Creates the tenant, its owner and default outlet and returns the owner's session (immediate sign-up, or
    POST /auth/verify-email with the pending registration's stored password hash)."""
    # The new tenant's id is chosen here and bound BEFORE the first insert (under RLS the insert's WITH CHECK needs it).
    rid = bind_tenant(db, uuid.uuid4())
    r = Restaurant(id=rid, name=data.restaurant_name, trn=data.trn, country=L.COUNTRY, currency=L.CURRENCY,
                   timezone=L.TIMEZONE, prices_include_tax=L.PRICES_INCLUDE_TAX, business_types=data.business_types)
    db.add(r)
    db.flush()
    u = User(restaurant_id=r.id, email=data.owner_email, full_name=data.owner_name,
             password_hash=password_hash or hash_password(data.owner_password), role=Role.owner)
    db.add(u)
    L.seed_rates(db, r)
    db.flush()
    outlets.create_default(db, r)  # every tenant has exactly one default outlet from the start
    dev = devices.record_login(db, u, devices.client_device(request))
    _, out = tokens.issue_pair(db, u, _device(request), login_device_id=dev.id)
    db.commit()
    return out


@router.post("/login", response_model=TokenOut, responses={409: {"description": "Correct password for several "
            "restaurants: body {detail, code: 'restaurant_choice_required', restaurants: [{restaurant_id, restaurant_name, "
            "role}]}; repeat the request with restaurant_id (docs/AUTH_CONTRACT.md)"}})
def login(data: LoginIn, request: Request, db: Session = Depends(get_db)):
    """Email + password, or restaurant code + phone / username / email + password (staff; docs/STAFF_WIRING_CHECK.md).
    `password_change_required` in the answer: the password was a one-time password, ask for a new one. An owner / manager
    with TOTP on gets the MFA challenge instead of tokens (docs/AUTH_CONTRACT.md), whichever way they signed in."""
    key, ip = accounts.throttle_key(data.email or ""), accounts.client_ip(request)
    if data.restaurant_code:  # the code picks the tenant: no cross-restaurant lookup, no restaurant choice
        u = staff_accounts.authenticate_with_code(db, data.restaurant_code, data.identifier, data.password, ip)
        return _mfa_or_signed_in(db, request, u, data.device_label)
    wait = accounts.retry_after(db, key, ip)
    if wait:  # checked before any password work, and identical for known and unknown emails
        raise HTTPException(429, "Too many failed login attempts. Try again later.",
                            headers={"Retry-After": str(wait)})
    # The password is verified against EVERY account holding this email before anything else is said (finding 1): a wrong
    # password is always the same 401, and only a correct one can learn that it opens several restaurants.
    matches = accounts.password_matches(db, data.email, data.password, data.restaurant_id)
    if not matches:
        accounts.record_failure(db, key, ip)
        raise HTTPException(401, "Invalid credentials")
    accounts.clear_failures(db, key)
    if len(matches) > 1:
        msg = "This email and password open several restaurants. Choose one and sign in again with its restaurant_id."
        choices = [{"restaurant_id": str(m.restaurant_id), "restaurant_name": m.restaurant_name, "role": m.role}
                   for m in matches]
        return JSONResponse(status_code=409, content={
            "detail": msg, "code": "restaurant_choice_required", "restaurants": choices,
            "error": {"code": "restaurant_choice_required", "message": msg, "details": {"restaurants": choices}}})
    db.rollback()  # the candidate lookup ran unbound; bind the chosen tenant on a fresh transaction
    bind_tenant(db, matches[0].restaurant_id)
    u = db.get(User, matches[0].user_id)
    return _mfa_or_signed_in(db, request, u, data.device_label)


def _mfa_or_signed_in(db: Session, request: Request, u: User, device_label: str | None):
    gate = mfa.login_gate(db, u)  # owner / manager with TOTP on (or required by MFA_REQUIRED_ROLES): no tokens yet
    if gate:
        db.rollback()
        return JSONResponse(status_code=200, content=gate)
    return _signed_in(db, request, u, device_label)


def _signed_in(db: Session, request: Request, u: User, device_label: str | None) -> TokenOut:
    """The common end of every successful sign-in: optional new-device notice, token pair."""
    label = _device(request, device_label)
    alert = None
    try:  # the optional 'new device' notice (tenant setting, default off) never affects the login itself
        rest = db.get(Restaurant, u.restaurant_id)
        if rest and u.email and rest.login_alert_emails and account_mail.is_new_device(db, u, label):
            alert = (u.email, comms_templates.pick_locale(request.headers.get("accept-language")), rest.name, u.full_name)
    except Exception:  # noqa: BLE001
        alert = None
    dev = devices.record_login(db, u, devices.client_device(request, device_label))  # docs/STAFF_PIN_DEVICES_API.md
    _, out = tokens.issue_pair(db, u, label, login_device_id=dev.id)
    out.password_change_required = bool(u.must_change_password)
    db.commit()
    if alert:
        account_mail.notify_new_device_to(*alert, label)
    return out


@router.post("/forgot-password")
def forgot_password(data: ForgotPasswordIn, request: Request, db: Session = Depends(get_db)):
    """Public. ALWAYS the same 200 answer, whether or not the email has an account (no user enumeration); the reset link is
    emailed, one per restaurant the email belongs to. Rate limited per client IP and per email (429 for both alike)."""
    ip = request.client.host if request.client else "unknown"
    email = data.email.strip().lower()
    abuse.throttle([(f"forgot:ip:{ip}", settings.forgot_per_ip_per_hour),
                    (f"forgot:email:{hashlib.sha256(email.encode()).hexdigest()}", settings.forgot_per_email_per_hour)],
                   window=timedelta(hours=1), what="password reset requests")
    if settings.password_reset_mode != "link":  # a 6-digit code (docs/EMAIL.md), then /auth/password-reset/verify
        return account_otp.request_reset(db, email, request, data.restaurant_id)
    locale = comms_templates.pick_locale(data.locale, request.headers.get("accept-language"))
    rid = data.restaurant_id
    if data.restaurant_code:  # one restaurant only; an unknown code sends nothing (same answer)
        code = data.restaurant_code.strip().upper().replace("-", "").replace(" ", "")
        rid = staff_accounts.restaurant_by_code(db, code) or uuid.UUID(int=0)
        db.rollback()
    account_mail.request_reset(db, email, locale, rid)
    return {"detail": "If an account exists for this email, a reset link has been sent."}


@router.post("/reset-password", status_code=204)
def reset_password_with_token(data: ResetWithTokenIn, request: Request, db: Session = Depends(get_db)):
    """Public. Sets a new password with the single-use token from the emailed link (30 minutes), signs the user out on every
    device and emails a 'password changed' notice. Every failure is the same 400."""
    ip = request.client.host if request.client else "unknown"
    abuse.throttle([(f"reset:ip:{ip}", settings.reset_per_ip_per_hour)], window=timedelta(hours=1), what="reset attempts")
    account_mail.complete_reset(db, data.restaurant_id, data.token, data.new_password,
                                comms_templates.pick_locale(data.locale, request.headers.get("accept-language")))
    return Response(status_code=204)


@router.post("/refresh", response_model=TokenOut)
def refresh(data: RefreshIn, request: Request, db: Session = Depends(get_db)):
    """Rotates the refresh token: returns a new pair and revokes the presented token. 401 = sign in again;
    409 = this token was rotated a moment ago by a concurrent request (use the newest stored token)."""
    return tokens.refresh(db, data.refresh_token, request.headers.get("user-agent"), devices.client_ip(request))


@router.post("/logout", status_code=204)
def logout(data: RefreshIn, db: Session = Depends(get_db)):
    """Revokes this device's session. No access token needed (it may already be expired); always 204."""
    tokens.logout(db, data.refresh_token)
    return Response(status_code=204)


@router.get("/me", response_model=MeOut)
def me(p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """The caller, the outlet this request works in (`outlet_id`) and the outlets the caller may switch to with X-Outlet-Id."""
    reachable = [o for o in outlets.list_outlets(db, p.restaurant_id) if p.outlet_ids is None or o.id in p.outlet_ids]
    rest = db.get(Restaurant, p.restaurant_id)
    out = dict(outlet_id=p.outlet_id, outlets=[OutletOut.model_validate(o) for o in reachable], permissions=sorted(p.permissions),
               country=rest.country, currency=rest.currency, currency_symbol=rest.currency_symbol, timezone=rest.timezone,
               tax_word=rest.tax_word, kitchen_target_minutes=rest.kitchen_target_minutes,
               order_rules={"require_kot_before_bill": rest.require_kot_before_bill, "kitchen_status_mode": rest.kitchen_status_mode,
                            "kitchen_display_minutes": rest.kitchen_display_minutes})
    out["business_types"], out["capabilities"] = business_type.for_restaurant(db, p.restaurant_id, p.outlet_id)
    out["features"] = feature_access.effective(rest, entitlements.current(p.restaurant_id))
    if p.support:  # platform support session: not a tenant user, read-only, bounded by the token's claims
        return MeOut(id=p.user_id, email="support@platform", full_name="Platform support", role=p.role, is_active=True,
                     read_only=True, support_access={"staff_id": p.support["sub"], "grant_id": p.support["grant_id"],
                                                     "scope": p.support["scope"]}, **out)
    u = db.get(User, p.user_id)
    out.update(restaurant_name=rest.name, restaurant_code=rest.login_code, phone=u.phone, username=u.username,
               must_change_password=bool(u.must_change_password))
    e = entitlements.current(p.restaurant_id)
    warning = e.warning or ("suspended" if e and e.suspended else None) if e else None
    if p.pin_session:  # a counter PIN session: the tablet shows the idle lock / hard expiry from here
        out["session"] = {"kind": "pin", **{k: str(v) if k.endswith("_id") else v for k, v in p.pin_session.items()}}
    return MeOut(id=u.id, email=u.email, full_name=u.full_name, role=u.role, is_active=u.is_active,
                 entitlements=e.as_dict() if e else None, entitlement_warning=warning,
                 read_only=bool(e and e.suspended and entitlements.mode() == "on"),
                 billing=wallet.billing_for(db, p.restaurant_id), **out)


@router.get("/users/{user_id}/outlets", response_model=OutletAccessOut)
def get_user_outlets(user_id: uuid.UUID, p: Principal = Depends(require_perm(P.STAFF_VIEW)), db: Session = Depends(get_db)):
    """Outlets granted to a user. Owners / managers reach every outlet regardless; a user without grants reaches the default
    outlet only."""
    if not db.scalar(select(User.id).where(User.id == user_id, User.restaurant_id == p.restaurant_id)):
        raise HTTPException(404, "User not found")
    return OutletAccessOut(outlet_ids=outlets.get_access(db, p.restaurant_id, user_id))


@router.put("/users/{user_id}/outlets", response_model=OutletAccessOut)
def set_user_outlets(user_id: uuid.UUID, data: OutletAccessIn, p: Principal = Depends(require_perm(P.STAFF_MANAGE_OUTLET_ACCESS)),
                     db: Session = Depends(get_db)):
    """Owner only. Replaces the outlets a cashier / waiter / kitchen user may work in; an empty list resets to the default outlet."""
    staff_accounts.require_can_scope(p, staff_accounts.get_user(db, p, user_id))
    return OutletAccessOut(outlet_ids=outlets.set_access(db, p, user_id, data.outlet_ids))


@router.get("/users", response_model=list[StaffOut])
def list_users(p: Principal = Depends(require_perm(P.STAFF_VIEW)), db: Session = Depends(get_db)):
    return manage.list_staff(db, p)


@router.patch("/users/{user_id}", response_model=UserOut)
def patch_user(user_id: uuid.UUID, data: UserPatch, p: Principal = Depends(require_perm(P.STAFF_MANAGE_ROLES)),
               db: Session = Depends(get_db)):
    """Owner only. Rename and/or change role; the last active owner can never be demoted."""
    return manage.patch_user(db, p, user_id, data)


@router.post("/users", response_model=StaffCreatedOut, status_code=201)
def create_user(data: UserCreate, request: Request, p: Principal = Depends(require_perm(P.STAFF_CREATE)),
                db: Session = Depends(get_db)):
    """Adds a staff member to THIS restaurant (docs/STAFF_WIRING_CHECK.md). Email, phone and username are optional (at least
    one) and unique inside the restaurant only: the same email in another restaurant is a separate account and nothing about
    it is revealed. `outlet_ids` grants outlets at once. Credentials: `password`, or `send_invite` (emailed single-use link),
    or else a one-time password returned ONCE as `temporary_password`. The caller can only create roles whose permissions it
    holds (only owners create owners)."""
    return staff_accounts.create_staff(db, p, data, comms_templates.pick_locale(request.headers.get("accept-language")))


@router.post("/users/{user_id}/temporary-password", response_model=TemporaryPasswordOut)
def temporary_password(user_id: uuid.UUID, p: Principal = Depends(require_perm(P.STAFF_RESET_PASSWORD)),
                       db: Session = Depends(get_db)):
    """Owner only. Generates a one-time password for a staff member (shown once; they must choose a new one at the next
    sign-in) and ends every session of that user."""
    return staff_accounts.temporary_password(db, p, user_id)


@router.post("/users/{user_id}/invite", response_model=StaffInviteOut)
def invite_user(user_id: uuid.UUID, request: Request, p: Principal = Depends(require_perm(P.STAFF_RESET_PASSWORD)),
                db: Session = Depends(get_db)):
    """Owner only. (Re)sends the 'choose your password' email (single use, PROVISION_INVITE_HOURS); older links stop working.
    The link is also returned once, to share another way."""
    return staff_accounts.resend_invite(db, p, user_id, comms_templates.pick_locale(request.headers.get("accept-language")))


@router.post("/change-password", status_code=204)
def change_password(data: ChangePasswordIn, request: Request, p: Principal = Depends(current_principal),
                    db: Session = Depends(get_db)):
    accounts.change_password(db, p, data.current_password, data.new_password, accounts.client_ip(request))


@router.post("/users/{user_id}/reset-password", status_code=204)
def reset_user_password(user_id: uuid.UUID, data: ResetPasswordIn, p: Principal = Depends(require_perm(P.STAFF_RESET_PASSWORD)),
                        db: Session = Depends(get_db)):
    """Owner only. Sets a new password for a staff member and signs them out on every device."""
    accounts.reset_password(db, p, user_id, data.new_password)
    return Response(status_code=204)


@router.post("/users/{user_id}/deactivate", response_model=UserOut)
def deactivate_user(user_id: uuid.UUID, p: Principal = Depends(require_perm(P.STAFF_DEACTIVATE)),
                    db: Session = Depends(get_db)):
    return accounts.set_active(db, p, user_id, False)


@router.post("/users/{user_id}/reactivate", response_model=UserOut)
def reactivate_user(user_id: uuid.UUID, p: Principal = Depends(require_perm(P.STAFF_DEACTIVATE)),
                    db: Session = Depends(get_db)):
    return accounts.set_active(db, p, user_id, True)
