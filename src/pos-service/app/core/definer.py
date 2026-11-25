"""SECURITY DEFINER functions for the paths that run BEFORE the tenant is known, or across tenants by design
(docs/PHASE1_PLAN.md section (b) "Pre-tenant and cross-tenant paths", PR 2).

Under RLS (PR 3) the app role sees nothing until a tenant is bound, so these lookups go through functions owned by the
owner role (exempt from its own non-FORCEd policies). Each one takes only typed arguments (no free-form SQL), returns the
minimum (ids), uses a fixed ``search_path``, and is not executable by PUBLIC; the app role gets EXECUTE through the default
privileges set up by app/core/db_roles.grant_privileges (or as the owner itself in a single-user setup).

This module is the single source of the SQL: the Alembic revision and the test fixture both call ``create_all``.
``FUNCTIONS`` is the allowlist a test checks against the database.
"""
from sqlalchemy import text
from sqlalchemy.engine import Connection

_HEADER = "SECURITY DEFINER SET search_path = public, pg_temp"

# name -> (identity arguments for DROP / GRANT, CREATE OR REPLACE statement)
FUNCTIONS: dict[str, tuple[str, str]] = {
    # POST /auth/login: (user_id, restaurant_id) of at most two users with this email; the caller binds the tenant and then
    # loads the user (and its password hash) normally.
    "auth_find_users": ("text, uuid", f"""
CREATE OR REPLACE FUNCTION auth_find_users(p_email text, p_restaurant_id uuid DEFAULT NULL)
RETURNS TABLE (user_id uuid, restaurant_id uuid)
LANGUAGE sql STABLE {_HEADER} AS $$
  SELECT u.id, u.restaurant_id FROM users u
   WHERE lower(u.email) = lower(p_email) AND (p_restaurant_id IS NULL OR u.restaurant_id = p_restaurant_id)
   LIMIT 2
$$"""),
    # POST /auth/login and /auth/register-restaurant (security review finding 1): every (user, restaurant) pair holding this
    # email, case-insensitive, active or not, oldest first, at most 10. Login checks the password against each one (in that
    # tenant's own session) BEFORE it says anything about how many there are; registration refuses an email already in use.
    "auth_login_candidates": ("text, uuid", f"""
CREATE OR REPLACE FUNCTION auth_login_candidates(p_email text, p_restaurant_id uuid DEFAULT NULL)
RETURNS TABLE (user_id uuid, restaurant_id uuid)
LANGUAGE sql STABLE {_HEADER} AS $$
  SELECT u.id, u.restaurant_id FROM users u
   WHERE lower(u.email) = lower(p_email) AND (p_restaurant_id IS NULL OR u.restaurant_id = p_restaurant_id)
   ORDER BY u.created_at, u.id LIMIT 10
$$"""),
    # POST /auth/login and /auth/forgot-password with a restaurant code (staff sign-in): the tenant id of a login code
    # (case-insensitive), or NULL. The caller binds that tenant and looks the user up under RLS (docs/STAFF_WIRING_CHECK.md).
    "auth_restaurant_by_code": ("text", f"""
CREATE OR REPLACE FUNCTION auth_restaurant_by_code(p_code text)
RETURNS uuid
LANGUAGE sql STABLE {_HEADER} AS $$
  SELECT r.id FROM restaurants r WHERE r.login_code = upper(p_code)
$$"""),
    # POST /auth/refresh and /auth/logout: the tenant of a refresh token, found by its hash.
    "auth_refresh_tenant": ("text", f"""
CREATE OR REPLACE FUNCTION auth_refresh_tenant(p_token_hash text)
RETURNS uuid
LANGUAGE sql STABLE {_HEADER} AS $$
  SELECT t.restaurant_id FROM refresh_tokens t WHERE t.token_hash = p_token_hash
$$"""),
    # POST /auth/forgot-password: the (user, restaurant) pairs of ACTIVE users with this email (case-insensitive), at most 10; the
    # caller binds each tenant to load the user and write the token. Returns ids only.
    "auth_find_reset_users": ("text", f"""
CREATE OR REPLACE FUNCTION auth_find_reset_users(p_email text)
RETURNS TABLE (user_id uuid, restaurant_id uuid)
LANGUAGE sql STABLE {_HEADER} AS $$
  SELECT u.id, u.restaurant_id FROM users u
   WHERE lower(u.email) = lower(p_email) AND u.is_active
   ORDER BY u.created_at LIMIT 10
$$"""),
    # whatsapp.sweep(): queued WhatsApp messages that are due, claimed by pushing next_attempt_at forward (a lease) under
    # FOR UPDATE SKIP LOCKED, so concurrent workers get disjoint rows and a dead worker's rows come back after the lease.
    "whatsapp_due_work": ("timestamp with time zone, integer, integer", f"""
CREATE OR REPLACE FUNCTION whatsapp_due_work(p_now timestamptz, p_limit integer, p_lease_seconds integer)
RETURNS TABLE (tenant_id uuid, id uuid)
LANGUAGE sql VOLATILE {_HEADER} AS $$
  WITH due AS (
    SELECT o.id FROM whatsapp_outbox o
     WHERE o.status = 'queued' AND o.next_attempt_at <= p_now
     ORDER BY o.next_attempt_at LIMIT p_limit
     FOR UPDATE SKIP LOCKED
  )
  UPDATE whatsapp_outbox o SET next_attempt_at = p_now + make_interval(secs => p_lease_seconds)
    FROM due WHERE o.id = due.id
  RETURNING o.restaurant_id, o.id
$$"""),
    # Print hub bearer token -> (hub_id, tenant_id). Revocation is checked by the caller after binding the tenant.
    "hub_by_token": ("text", f"""
CREATE OR REPLACE FUNCTION hub_by_token(p_token_hash text)
RETURNS TABLE (hub_id uuid, tenant_id uuid)
LANGUAGE sql STABLE {_HEADER} AS $$
  SELECT h.id, h.restaurant_id FROM print_hubs h WHERE h.token_hash = p_token_hash
$$"""),
    # Counter device credential (X-Counter-Token / pin-login body) -> (device_id, tenant_id). Revocation is checked by the
    # caller after binding the tenant (docs/STAFF_PIN_DEVICES_API.md).
    "counter_device_by_token": ("text", f"""
CREATE OR REPLACE FUNCTION counter_device_by_token(p_token_hash text)
RETURNS TABLE (device_id uuid, tenant_id uuid)
LANGUAGE sql STABLE {_HEADER} AS $$
  SELECT d.id, d.restaurant_id FROM counter_devices d WHERE d.token_hash = p_token_hash
$$"""),
    # POST /print/hub/pair: single use, atomically (only one caller can flip used_at from NULL); the tenant AND outlet the code
    # was issued for come back from the same statement, so the hub is bound to exactly what the code was bound to.
    "claim_hub_pairing": ("text, timestamp with time zone", f"""
CREATE OR REPLACE FUNCTION claim_hub_pairing(p_code_hash text, p_now timestamptz)
RETURNS TABLE (tenant_id uuid, created_by uuid, outlet_id uuid)
LANGUAGE sql VOLATILE {_HEADER} AS $$
  UPDATE hub_pairings SET used_at = p_now
   WHERE code_hash = p_code_hash AND used_at IS NULL AND expires_at > p_now
  RETURNING restaurant_id, created_by, outlet_id
$$"""),
    # printing.sweep_all(): tenants with a `sent` print job the hub never answered, or a queued slip old enough to expire.
    "print_sweep_tenants": ("timestamp with time zone, timestamp with time zone", f"""
CREATE OR REPLACE FUNCTION print_sweep_tenants(p_stale_before timestamptz, p_expire_before timestamptz)
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql STABLE {_HEADER} AS $$
  SELECT DISTINCT j.restaurant_id FROM print_jobs j
   WHERE (j.status = 'sent' AND j.sent_at < p_stale_before) OR (j.status = 'queued' AND j.created_at < p_expire_before)
$$"""),
    # reorder.sweep(): tenants with low items still to email ('run_auto', id NULL), and queued emails whose sender died,
    # claimed by renewing updated_at under FOR UPDATE SKIP LOCKED ('deliver', email id).
    "reorder_due_work": ("timestamp with time zone", f"""
CREATE OR REPLACE FUNCTION reorder_due_work(p_stale_before timestamptz)
RETURNS TABLE (tenant_id uuid, kind text, id uuid)
LANGUAGE sql VOLATILE {_HEADER} AS $$
  WITH due AS (
    SELECT DISTINCT a.restaurant_id FROM alerts a
     WHERE a.kind = 'low_stock' AND a.status = 'open' AND a.email_pending AND a.supplier_email_id IS NULL
  ), stale AS (
    SELECT e.id FROM supplier_emails e
     WHERE e.status = 'queued' AND e.updated_at < p_stale_before
     FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE supplier_emails e SET updated_at = now() FROM stale WHERE e.id = stale.id
    RETURNING e.restaurant_id, e.id
  )
  SELECT due.restaurant_id, 'run_auto'::text, NULL::uuid FROM due
  UNION ALL
  SELECT claimed.restaurant_id, 'deliver'::text, claimed.id FROM claimed
$$"""),
    # purchases.claim_stale() at startup: invoices stuck in `uploaded`, claimed by renewing updated_at
    # (FOR UPDATE SKIP LOCKED gives concurrent replicas disjoint rows). Oldest first.
    "claim_stale_purchases": ("integer, integer", f"""
CREATE OR REPLACE FUNCTION claim_stale_purchases(p_limit integer, p_stale_minutes integer)
RETURNS TABLE (id uuid, tenant_id uuid)
LANGUAGE sql VOLATILE {_HEADER} AS $$
  WITH stale AS (
    SELECT p.id, p.updated_at AS since FROM purchase_invoices p
     WHERE p.status = 'uploaded' AND p.updated_at < now() - make_interval(mins => p_stale_minutes)
     ORDER BY p.updated_at LIMIT p_limit
     FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE purchase_invoices p SET updated_at = now() FROM stale WHERE p.id = stale.id
    RETURNING p.id, p.restaurant_id
  )
  SELECT claimed.id, claimed.restaurant_id FROM claimed JOIN stale ON stale.id = claimed.id ORDER BY stale.since, claimed.id
$$"""),
    # voice.purge_transcripts(): retention purge across all tenants (a background job has no tenant bound).
    "voice_purge_transcripts": ("timestamp with time zone", f"""
CREATE OR REPLACE FUNCTION voice_purge_transcripts(p_before timestamptz)
RETURNS integer
LANGUAGE sql VOLATILE {_HEADER} AS $$
  WITH d AS (DELETE FROM voice_transcripts WHERE created_at < p_before RETURNING 1) SELECT count(*)::integer FROM d
$$"""),
    # delivery_outbox.run_once(): tenants with a webhook due (pending, retry time reached, no earlier event of the same order
    # still pending). The runner binds each tenant and claims the rows itself, under RLS.
    "delivery_outbox_tenants": ("timestamp with time zone", f"""
CREATE OR REPLACE FUNCTION delivery_outbox_tenants(p_now timestamptz)
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql STABLE {_HEADER} AS $$
  SELECT DISTINCT o.restaurant_id FROM delivery_outbox o
   WHERE o.status = 'pending' AND o.next_attempt_at <= p_now
$$"""),
    # daily_report.sweep(): tenants with the end of day report email switched on (docs/EMAIL.md). Ids only; the sweep binds
    # each tenant and decides per outlet (local time, ledger row) under RLS.
    "daily_report_tenants": ("", f"""
CREATE OR REPLACE FUNCTION daily_report_tenants()
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql STABLE {_HEADER} AS $$
  SELECT r.id FROM restaurants r WHERE r.daily_report_email
$$"""),
    # wallet.run_once(): tenants with PAYG usage events due for (re)sending to platform-core. The runner binds each tenant and
    # claims the rows itself, under RLS (docs/PAYG_BILLING.md).
    "billing_usage_tenants": ("timestamp with time zone", f"""
CREATE OR REPLACE FUNCTION billing_usage_tenants(p_now timestamptz)
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql STABLE {_HEADER} AS $$
  SELECT DISTINCT o.restaurant_id FROM billing_usage_outbox o
   WHERE o.status IN ('pending', 'unmanaged') AND o.next_attempt_at <= p_now
$$"""),
}


# What migration b2d4f6a8c0e1 (PR 2) must create on a FRESH database: the functions as they were then. A migration must never
# run today's SQL against yesterday's schema (claim_hub_pairing now returns outlet_id, a column that only exists after the
# outlets migrations; print_sweep_tenants did not exist). Later migrations (b9e1c3d5f7a2) replace them with the current ones.
_EXISTED_AT_PR2 = frozenset({"auth_find_users", "auth_refresh_tenant", "claim_hub_pairing", "claim_stale_purchases", "hub_by_token",
                             "reorder_due_work"})  # an ALLOWLIST: functions added later must never run in this old migration
_AS_OF_PR2 = {
    "claim_hub_pairing": ("text, timestamp with time zone", f"""
CREATE OR REPLACE FUNCTION claim_hub_pairing(p_code_hash text, p_now timestamptz)
RETURNS TABLE (tenant_id uuid, created_by uuid)
LANGUAGE sql VOLATILE {_HEADER} AS $$
  UPDATE hub_pairings SET used_at = p_now
   WHERE code_hash = p_code_hash AND used_at IS NULL AND expires_at > p_now
  RETURNING restaurant_id, created_by
$$"""),
}


def create_all(conn: Connection, *, as_of_pr2: bool = False) -> None:
    """Creates (or replaces) every function as the CURRENT role, which must be the owner role, and removes PUBLIC's
    EXECUTE. Run after the tables exist. as_of_pr2=True is for migration b2d4f6a8c0e1 only (see _AS_OF_PR2)."""
    for name, (args, sql) in FUNCTIONS.items():
        if as_of_pr2:
            if name not in _EXISTED_AT_PR2:
                continue
            args, sql = _AS_OF_PR2.get(name, (args, sql))
        conn.execute(text(sql))
        conn.execute(text(f"REVOKE ALL ON FUNCTION {name}({args}) FROM PUBLIC"))


def drop_all(conn: Connection) -> None:
    for name, (args, _) in FUNCTIONS.items():
        conn.execute(text(f"DROP FUNCTION IF EXISTS {name}({args})"))
