"""Live end-to-end check of the staff wiring (docs/STAFF_WIRING_CHECK.md): owners add waiters / kitchen / managers, and a
staff login opens ONLY its own restaurant and only the outlets it is assigned.

Runs against a running pos-service (default the local compose stack on :8000) with throwaway tenants named `wire-...`.
It registers TWO restaurants per run (POST /auth/register-restaurant is limited to 5 per IP per hour), never touches other
tenants, and prints a table of checks plus a JSON file. Features that the server does not have yet (restaurant code login,
staff without email, temporary passwords) are reported as `unsupported` instead of failing the run.

    .venv/bin/python scripts/staff_wiring_check.py --base http://127.0.0.1:8000/api/v1 --out /tmp/wire.json

Exit code 0 when every check that the server supports passed, 1 otherwise.
"""
from __future__ import annotations

import argparse
import json
import secrets
import sys
import time
import uuid
from dataclasses import asdict, dataclass

import httpx

PW = "Kesar-Lamp-7319x"  # passes the password policy of phase4/security too (no name / email parts)
PW2 = "Mango-Tile-8426y"


def rid_of(token: str) -> str:
    """The tenant claim of an access token (read only, not verified: for building cross-tenant attempts)."""
    import base64
    part = token.split(".")[1]
    return json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))["rid"]


@dataclass
class Check:
    id: str
    scenario: str
    expected: str
    actual: str
    status: str  # pass | FAIL | unsupported | info


class Run:
    def __init__(self, base: str):
        self.c = httpx.Client(base_url=base.rstrip("/"), timeout=30)
        self.checks: list[Check] = []
        self.sfx = time.strftime("%m%d%H%M") + secrets.token_hex(2)

    # ---------------------------------------------------------------- helpers
    def rec(self, cid, scenario, expected, actual, ok: bool | None):
        st = "info" if ok is None else ("pass" if ok else "FAIL")
        self.checks.append(Check(cid, scenario, expected, str(actual)[:300], st))
        print(f"[{st:11}] {cid:6} {scenario} -> {str(actual)[:160]}")

    def unsupported(self, cid, scenario, expected, actual):
        self.checks.append(Check(cid, scenario, expected, str(actual)[:300], "unsupported"))
        print(f"[unsupported] {cid:6} {scenario} -> {str(actual)[:160]}")

    def h(self, tok, outlet=None, **extra):
        out = {"Authorization": f"Bearer {tok}"}
        if outlet:
            out["X-Outlet-Id"] = str(outlet)
        out.update(extra)
        return out

    def email(self, who):
        return f"wire-{who}-{self.sfx}@wire.example.com"

    def login(self, **body):
        body.setdefault("device_label", "wire-check")
        return self.c.post("/auth/login", json=body)

    def register(self, tag):
        r = self.c.post("/auth/register-restaurant", json={
            "restaurant_name": f"wire-{tag}-{self.sfx}", "country": "IN", "owner_email": self.email(f"{tag}-owner"),
            "owner_name": f"Wire Owner {tag.upper()}", "owner_password": PW, "business_types": ["restaurant"]})
        if r.status_code == 202:  # phase4/mail: e-mail verification first; this script cannot read the code
            raise SystemExit("register-restaurant asks for e-mail verification (202): run against a server with "
                             "SIGNUP_EMAIL_VERIFICATION=0")
        assert r.status_code == 201, r.text
        tok = r.json()["access_token"]
        me = self.c.get("/auth/me", headers=self.h(tok)).json()
        return tok, me

    def create_staff(self, owner_tok, **body):
        body.setdefault("full_name", "Wire Staff")
        return self.c.post("/auth/users", json=body, headers=self.h(owner_tok))

    def seed_menu(self, tok, outlet, tag):
        cat = self.c.post("/menu/categories", json={"name": f"Mains {tag}"}, headers=self.h(tok, outlet)).json()
        item = self.c.post("/menu/items", json={"category_id": cat["id"], "name": f"Dal {tag}", "price": "120.00"},
                           headers=self.h(tok, outlet)).json()
        table = self.c.post("/tables", json={"label": f"T-{tag}"}, headers=self.h(tok, outlet)).json()
        return item, table

    def order(self, tok, outlet, item, table=None):
        body = {"client_uuid": str(uuid.uuid4()), "order_type": "indoor" if table else "takeaway",
                "table_id": table["id"] if table else None, "lines": [{"item_id": item["id"], "quantity": 1}]}
        return self.c.post("/orders", json=body, headers=self.h(tok, outlet))

    # ---------------------------------------------------------------- scenario
    def run(self):
        c = self.c
        # (1) two restaurants
        a_tok, a_me = self.register("a")
        b_tok, b_me = self.register("b")
        a_rid, b_rid = rid_of(a_tok), rid_of(b_tok)
        self.rec("R1", "Owner A and owner B register (India)", "201 each, separate tenants",
                 f"A outlets={len(a_me['outlets'])} B outlets={len(b_me['outlets'])}", a_me["id"] != b_me["id"])
        a_x = a_me["outlet_id"]
        b_x = b_me["outlet_id"]
        ry = c.post("/outlets", json={"name": f"wire-a-rooftop-{self.sfx}", "code": "ROOF", "invoice_prefix": "RF"},
                    headers=self.h(a_tok))
        a_y = ry.json().get("id")
        self.rec("R2", "Owner A adds a second outlet (hotel / multi-outlet)", "201", ry.status_code, ry.status_code == 201)
        a_item_x, a_tab_x = self.seed_menu(a_tok, a_x, "AX")
        a_item_y, a_tab_y = self.seed_menu(a_tok, a_y, "AY")
        b_item, b_tab = self.seed_menu(b_tok, b_x, "B")
        b_order = self.order(b_tok, b_x, b_item, b_tab).json()
        a_order_y = self.order(a_tok, a_y, a_item_y, a_tab_y).json()

        rest_a = c.get("/restaurant", headers=self.h(a_tok)).json()
        rest_b = c.get("/restaurant", headers=self.h(b_tok)).json()
        code_a, code_b = rest_a.get("login_code"), rest_b.get("login_code")
        if code_a:
            self.rec("C1", "Each restaurant has a short login code (Manage > Restaurant)", "6 chars, different per tenant",
                     f"A={code_a} B={code_b}", len(code_a) == 6 and code_a != code_b)
        else:
            self.unsupported("C1", "Each restaurant has a short login code", "restaurant.login_code", "absent")

        # (1) owner adds a waiter by email with an outlet assignment
        w_email = self.email("a-waiter")
        r = self.create_staff(a_tok, email=w_email, full_name="Wire Waiter A", password=PW, role="waiter", outlet_ids=[a_x])
        self.rec("S1", "Owner A adds a waiter (email, password, outlet X) via API", "201", r.status_code, r.status_code == 201)
        waiter = r.json()
        acc = c.get(f"/auth/users/{waiter['id']}/outlets", headers=self.h(a_tok)).json()
        granted_at_create = acc.get("outlet_ids") == [a_x]
        self.rec("S2", "Outlet assignment given at creation is stored", "outlet_ids == [X]", acc,
                 granted_at_create if "outlet_ids" in waiter or granted_at_create else False)
        if not granted_at_create:
            c.put(f"/auth/users/{waiter['id']}/outlets", json={"outlet_ids": [a_x]}, headers=self.h(a_tok))
        weak = self.create_staff(a_tok, email=self.email("weak"), password="aaaaaaaaaa", role="waiter")
        self.rec("S3", "Staff password policy (10 x 'a')", "422", weak.status_code, weak.status_code == 422)

        lw = self.login(email=w_email, password=PW)
        self.rec("L1", "Waiter first login by email + password (web counter / waiter app shape)", "200 token pair",
                 lw.status_code, lw.status_code == 200 and "access_token" in lw.json())
        w_tok, w_rt = lw.json()["access_token"], lw.json()["refresh_token"]
        me = c.get("/auth/me", headers=self.h(w_tok)).json()
        self.rec("L2", "Waiter /auth/me: role waiter, outlets only X", "role=waiter outlets=[X]",
                 f"role={me['role']} outlets={[o['id'] == a_x for o in me['outlets']]}",
                 me["role"] == "waiter" and [o["id"] for o in me["outlets"]] == [a_x])

        # restaurant code login (new scheme)
        if code_a:
            lc = self.login(restaurant_code=code_a.lower(), identifier=w_email, password=PW)
            self.rec("L3", "Login with restaurant code + email + password", "200", lc.status_code, lc.status_code == 200)
            lc2 = self.login(restaurant_code=code_b, identifier=w_email, password=PW)
            self.rec("L4", "A's waiter credentials with B's restaurant code", "401", lc2.status_code, lc2.status_code == 401)
            lcw = self.login(restaurant_code="ZZZZZZ", identifier=w_email, password=PW)
            self.rec("L5", "Unknown restaurant code", "401 (same as a wrong password)", lcw.status_code, lcw.status_code == 401)
            # staff without email: phone and username
            rp = self.create_staff(a_tok, full_name="Wire Phone Waiter", phone="+91 98765 43210", role="waiter",
                                   outlet_ids=[a_x])
            self.rec("P1", "Owner adds a waiter by phone only (no email); one-time password returned once", "201 + temporary_password",
                     f"{rp.status_code} temp={'temporary_password' in rp.json()}", rp.status_code == 201 and bool(rp.json().get("temporary_password")))
            if rp.status_code == 201:
                tmp = rp.json()["temporary_password"]
                lp = self.login(restaurant_code=code_a, identifier="9876543210", password=tmp)
                self.rec("P2", "Phone waiter logs in with code + phone (any format) + temp password", "200 must_change_password",
                         f"{lp.status_code} {lp.json().get('password_change_required')}",
                         lp.status_code == 200 and lp.json().get("password_change_required") is True)
                lst = c.get("/auth/users", headers=self.h(a_tok)).text
                self.rec("P3", "Staff list never returns a password or hash", "no password / hash", "",
                         tmp not in lst and "hash" not in lst and "argon" not in lst)
            ru = self.create_staff(a_tok, full_name="Wire User Waiter", username="Ramu", password=PW, role="waiter")
            self.rec("U1", "Owner adds a waiter by username only", "201", ru.status_code, ru.status_code == 201)
            dup = self.create_staff(a_tok, full_name="Dup", username="ramu", password=PW, role="waiter")
            self.rec("U2", "Username unique per restaurant (case-insensitive)", "409", dup.status_code, dup.status_code == 409)
            ub = self.create_staff(b_tok, full_name="Ramu B", username="ramu", password=PW2, role="waiter")
            self.rec("U3", "Same username in another restaurant", "201 (unique per restaurant only)", ub.status_code, ub.status_code == 201)
            la = self.login(restaurant_code=code_a, identifier="RAMU", password=PW)
            lb = self.login(restaurant_code=code_b, identifier="ramu", password=PW2)
            ok = la.status_code == 200 and lb.status_code == 200
            if ok:
                ma = c.get("/restaurant", headers=self.h(la.json()["access_token"])).json()["name"]
                mb = c.get("/restaurant", headers=self.h(lb.json()["access_token"])).json()["name"]
                ok = ma == rest_a["name"] and mb == rest_b["name"]
            self.rec("U4", "Code picks the tenant: 'ramu' of A opens A, 'ramu' of B opens B", "A->A, B->B",
                     f"{la.status_code}/{lb.status_code}", ok)
            lx = self.login(restaurant_code=code_b, identifier="ramu", password=PW)
            self.rec("U5", "A's ramu password with B's code", "401", lx.status_code, lx.status_code == 401)
            tp = c.post(f"/auth/users/{ru.json()['id']}/temporary-password", headers=self.h(a_tok)) if ru.status_code == 201 else None
            if tp is not None:
                self.rec("T1", "Owner generates a one-time temporary password for a staff member", "200 temporary_password",
                         tp.status_code, tp.status_code == 200 and bool(tp.json().get("temporary_password")))
                old = self.c.get("/auth/me", headers=self.h(la.json()["access_token"])) if la.status_code == 200 else None
                self.rec("T2", "Old sessions of that user after the temporary password", "refresh revoked (401)",
                         self.c.post("/auth/refresh", json={"refresh_token": la.json()["refresh_token"]}).status_code,
                         self.c.post("/auth/refresh", json={"refresh_token": la.json()["refresh_token"]}).status_code == 401)
                del old
        else:
            for cid in ("L3", "L4", "L5", "P1", "P2", "U1", "U2", "U3", "U4"):
                self.unsupported(cid, "restaurant-code / phone / username login", "supported", "no login_code on /restaurant")
            np = self.create_staff(a_tok, full_name="Wire Phone Waiter", phone="+919876543210", role="waiter", password=PW)
            self.rec("P0", "Owner adds a waiter without email (phone only)", "201", np.status_code, np.status_code == 201)

        # (2) the waiter works in A
        for path in ("/menu/items", "/tables", "/orders", "/menu/categories"):
            r = c.get(path, headers=self.h(w_tok))
            self.rec("W1", f"Waiter GET {path}", "200, only A's rows", r.status_code, r.status_code == 200)
        items = c.get("/menu/items", headers=self.h(w_tok)).json()
        self.rec("W2", "Waiter sees no menu item of B", "B's item absent", "", all(i["id"] != b_item["id"] for i in items))
        wo = self.order(w_tok, None, a_item_x, a_tab_x)
        self.rec("W3", "Waiter takes an order in outlet X", "201", wo.status_code, wo.status_code == 201)
        kot = c.post(f"/orders/{wo.json()['id']}/kot", headers=self.h(w_tok)) if wo.status_code == 201 else None
        self.rec("W4", "Waiter sends the KOT", "201", kot.status_code if kot else None, bool(kot) and kot.status_code == 201)

        # cross-tenant attempts
        r = c.get(f"/orders/{b_order['id']}", headers=self.h(w_tok))
        self.rec("X1", "Waiter A GET B's order id", "404", r.status_code, r.status_code == 404)
        r = self.order(w_tok, None, b_item, None)
        self.rec("X2", "Waiter A orders B's menu item id", "4xx, nothing created", r.status_code, r.status_code in (404, 409, 422))
        r = self.order(w_tok, None, a_item_x, b_tab)
        self.rec("X3", "Waiter A orders on B's table id", "4xx", r.status_code, r.status_code in (404, 409, 422))
        r = c.get("/orders", headers=self.h(w_tok, b_x))
        self.rec("X4", "Waiter A with X-Outlet-Id = B's outlet", "404", r.status_code, r.status_code == 404)
        r = c.get(f"/kot?outlet_id={b_x}", headers=self.h(w_tok))
        self.rec("X5", "Waiter A ?outlet_id= B's outlet", "403/404", r.status_code, r.status_code in (403, 404))
        r = c.get("/menu/items", headers=self.h(w_tok, **{"X-Restaurant": b_rid, "X-Restaurant-Id": "x"}))
        names = [i["name"] for i in r.json()] if r.status_code == 200 else []
        self.rec("X6", "Waiter A sends X-Restaurant / X-Restaurant-Id headers of B", "ignored: still A's menu",
                 f"{r.status_code} {names[:3]}", r.status_code == 200 and "Dal B" not in names)
        r = c.get(f"/menu/items?restaurant_id={b_rid}", headers=self.h(w_tok))
        self.rec("X7", "Waiter A ?restaurant_id= B", "ignored", r.status_code,
                 r.status_code == 200 and all(i["id"] != b_item["id"] for i in r.json()))
        r = self.login(email=w_email, password=PW, restaurant_id=b_rid)
        self.rec("X8", "Login with A's credentials and restaurant_id of B", "401", r.status_code, r.status_code == 401)

        # role escalation by the waiter
        r = self.create_staff(w_tok, email=self.email("evil"), password=PW, role="owner")
        self.rec("E1", "Waiter tries to add an owner", "403", r.status_code, r.status_code == 403)
        r = c.patch(f"/auth/users/{me['id']}", json={"role": "manager"}, headers=self.h(w_tok))
        self.rec("E2", "Waiter tries to promote itself", "403", r.status_code, r.status_code == 403)
        r = c.get("/auth/users", headers=self.h(w_tok))
        self.rec("E3", "Waiter lists staff", "403", r.status_code, r.status_code == 403)
        r = c.put(f"/auth/users/{me['id']}/outlets", json={"outlet_ids": [a_x, a_y]}, headers=self.h(w_tok))
        self.rec("E4", "Waiter grants itself outlet Y", "403", r.status_code, r.status_code == 403)

        # owner A against B's users
        b_users = c.get("/auth/users", headers=self.h(b_tok)).json()
        b_owner_id = b_users[0]["id"]
        for name, call in (
            ("GET outlets", lambda: c.get(f"/auth/users/{b_owner_id}/outlets", headers=self.h(a_tok))),
            ("PATCH", lambda: c.patch(f"/auth/users/{b_owner_id}", json={"full_name": "pwned"}, headers=self.h(a_tok))),
            ("deactivate", lambda: c.post(f"/auth/users/{b_owner_id}/deactivate", headers=self.h(a_tok))),
            ("reset-password", lambda: c.post(f"/auth/users/{b_owner_id}/reset-password", json={"new_password": PW2}, headers=self.h(a_tok))),
            ("GET role", lambda: c.get(f"/users/{b_owner_id}/role", headers=self.h(a_tok))),
        ):
            r = call()
            self.rec("X9", f"Owner A {name} on B's owner id", "404", r.status_code, r.status_code == 404)
        lb_ok = self.login(email=self.email("b-owner"), password=PW, restaurant_id=None)
        self.rec("X10", "B's owner unaffected by A's attempts", "B owner still logs in", lb_ok.status_code, lb_ok.status_code == 200)

        # owner A adds staff whose email belongs to B's owner
        r = self.create_staff(a_tok, email=self.email("b-owner"), password=PW2, role="waiter", full_name="Copy of B owner")
        self.rec("M1", "Owner A adds staff with B owner's email", "201 (separate account in A), nothing about B revealed",
                 f"{r.status_code} {r.text[:80]}", r.status_code == 201 and rest_b["name"] not in r.text)
        r1 = self.login(email=self.email("b-owner"), password=PW)
        name1 = c.get("/restaurant", headers=self.h(r1.json()["access_token"])).json()["name"] if r1.status_code == 200 else None
        self.rec("M2", "B's owner logs in by email + own password (A holds the same email)", "200 into B, never A",
                 f"{r1.status_code} {name1 or r1.text[:90]}", r1.status_code == 200 and name1 == rest_b["name"])
        r2 = self.login(email=self.email("b-owner"), password="Wrong-Pass-0000x")
        self.rec("M3", "Wrong password for an email held in A and B", "401, no restaurant names",
                 f"{r2.status_code} {r2.text[:90]}", r2.status_code == 401 and rest_b["name"] not in r2.text and rest_a["name"] not in r2.text)
        r3 = self.login(email=self.email("b-owner"), password=PW2)
        name3 = c.get("/restaurant", headers=self.h(r3.json()["access_token"])).json()["name"] if r3.status_code == 200 else None
        self.rec("M4", "A's copy logs in with A's password", "200 into A", f"{r3.status_code} {name3}",
                 r3.status_code == 200 and name3 == rest_a["name"])
        # same email, SAME password in both: must ask, never pick silently
        same = self.email("both")
        self.create_staff(a_tok, email=same, password=PW, role="waiter", full_name="Both A")
        self.create_staff(b_tok, email=same, password=PW, role="cashier", full_name="Both B")
        r4 = self.login(email=same, password=PW)
        body = r4.json() if r4.headers.get("content-type", "").startswith("application/json") else {}
        self.rec("M5", "Email in A and B with the same password, no restaurant chosen", "409 choice, no token",
                 f"{r4.status_code} {json.dumps(body)[:200]}", r4.status_code == 409 and "access_token" not in body)
        r5 = self.login(email=same, password="Wrong-Pass-0000x")
        self.rec("M6", "Same email, WRONG password", "401 (no hint that several restaurants exist)",
                 f"{r5.status_code} {r5.text[:120]}", r5.status_code == 401)
        if code_a:
            r6 = self.login(restaurant_code=code_a, identifier=same, password=PW)
            name6 = c.get("/restaurant", headers=self.h(r6.json()["access_token"])).json()["name"] if r6.status_code == 200 else None
            self.rec("M7", "Same email + restaurant code A", "200 into A", f"{r6.status_code} {name6}",
                     r6.status_code == 200 and name6 == rest_a["name"])
        dup = self.create_staff(a_tok, email=w_email.upper(), password=PW, role="waiter")
        self.rec("M8", "Email unique per restaurant, case-insensitive", "409", dup.status_code, dup.status_code == 409)

        # (3) outlets: waiter limited to X
        r = c.get("/orders", headers=self.h(w_tok, a_y))
        self.rec("O1", "Waiter (outlet X) opens outlet Y with X-Outlet-Id", "403", r.status_code, r.status_code == 403)
        r = c.get(f"/orders/{a_order_y['id']}", headers=self.h(w_tok))
        self.rec("O2", "Waiter (outlet X) GET an order of outlet Y by id", "404", r.status_code, r.status_code == 404)
        r = c.get(f"/tables/status?outlet_id={a_y}", headers=self.h(w_tok))
        self.rec("O3", "Waiter (outlet X) tables of Y via ?outlet_id", "403", r.status_code, r.status_code in (403, 422))
        r = self.order(w_tok, None, a_item_x, a_tab_y)
        self.rec("O4", "Waiter (outlet X) orders on a table of Y", "4xx", r.status_code, r.status_code in (404, 409, 422))
        # waiter with two outlets switches
        c.put(f"/auth/users/{me['id']}/outlets", json={"outlet_ids": [a_x, a_y]}, headers=self.h(a_tok))
        me2 = c.get("/auth/me", headers=self.h(w_tok)).json()
        r = c.get("/orders", headers=self.h(w_tok, a_y))
        self.rec("O5", "Owner grants X+Y: outlet picker shows both and Y opens", "2 outlets, 200",
                 f"{len(me2['outlets'])} {r.status_code}", len(me2["outlets"]) == 2 and r.status_code == 200)
        c.put(f"/auth/users/{me['id']}/outlets", json={"outlet_ids": [a_x]}, headers=self.h(a_tok))
        r = c.get("/orders", headers=self.h(w_tok, a_y))
        self.rec("O6", "Grant removed: Y refused at once (same token)", "403", r.status_code, r.status_code == 403)
        # kitchen at Y only
        ke = self.email("a-kitchen")
        rk = self.create_staff(a_tok, email=ke, password=PW, role="kitchen", full_name="Wire Kitchen Y", outlet_ids=[a_y])
        if rk.status_code == 201:
            c.put(f"/auth/users/{rk.json()['id']}/outlets", json={"outlet_ids": [a_y]}, headers=self.h(a_tok))
            c.post(f"/orders/{a_order_y['id']}/kot", headers=self.h(a_tok, a_y))
            kt = self.login(email=ke, password=PW).json()["access_token"]
            kots = c.get("/kot", headers=self.h(kt)).json()
            orders_seen = {k["order_id"] for k in kots}
            x_order = wo.json().get("id") if wo.status_code == 201 else None
            self.rec("K1", "Kitchen (outlet Y) lists tickets", "only Y's tickets (Y's order, not X's)",
                     f"{len(kots)} y={a_order_y['id'] in orders_seen} x={x_order in orders_seen}",
                     a_order_y["id"] in orders_seen and x_order not in orders_seen)
            r = c.get("/kot", headers=self.h(kt, a_x))
            self.rec("K2", "Kitchen (outlet Y) asks for outlet X", "403", r.status_code, r.status_code == 403)
            r = self.order(kt, None, a_item_y, None)
            self.rec("K3", "Kitchen cannot take orders", "403", r.status_code, r.status_code == 403)

        # manager limits, custom-role escalation, last owner
        me_ = self.email("a-manager")
        self.create_staff(a_tok, email=me_, password=PW, role="manager", full_name="Wire Manager")
        m_tok = self.login(email=me_, password=PW).json()["access_token"]
        r = self.create_staff(m_tok, email=self.email("m-owner"), password=PW, role="owner")
        self.rec("G1", "Manager creates an owner", "403", r.status_code, r.status_code == 403)
        owner_a_id = a_me["id"]
        r = c.post(f"/auth/users/{owner_a_id}/reset-password", json={"new_password": PW2}, headers=self.h(m_tok))
        self.rec("G2", "Manager resets the owner's password", "403", r.status_code, r.status_code == 403)
        r = c.post(f"/auth/users/{owner_a_id}/deactivate", headers=self.h(a_tok))
        self.rec("G3", "Owner deactivates itself (last owner)", "409", r.status_code, r.status_code == 409)
        r = c.patch(f"/auth/users/{owner_a_id}", json={"role": "manager"}, headers=self.h(a_tok))
        self.rec("G4", "Last owner demotes itself", "409", r.status_code, r.status_code == 409)
        # custom role that holds staff.create / staff.reset_password / staff.manage_roles but is otherwise small
        rr = c.post("/roles", json={"name": f"wire-shiftlead-{self.sfx}", "permissions": [
            "staff.view", "staff.create", "staff.reset_password", "staff.manage_roles", "staff.deactivate", "orders.create"]},
            headers=self.h(a_tok))
        if rr.status_code == 201:
            le = self.email("a-lead")
            lead = self.create_staff(a_tok, email=le, password=PW, role="waiter", full_name="Wire Lead").json()
            c.put(f"/users/{lead['id']}/role", json={"role_id": rr.json()["id"]}, headers=self.h(a_tok))
            lt = self.login(email=le, password=PW).json()["access_token"]
            r = self.create_staff(lt, email=self.email("lead-mgr"), password=PW, role="manager", full_name="Made by lead")
            self.rec("G5", "Custom role (staff.create, no settings) creates a MANAGER", "403 (cannot grant more than it holds)",
                     r.status_code, r.status_code == 403)
            r = c.post(f"/auth/users/{owner_a_id}/reset-password", json={"new_password": PW2}, headers=self.h(lt))
            self.rec("G6", "Custom role with staff.reset_password resets the OWNER's password (takeover)", "403",
                     r.status_code, r.status_code == 403)
            if r.status_code == 204:  # restore so the run can continue
                PWs = PW2
            else:
                PWs = PW
            r = c.patch(f"/auth/users/{lead['id']}", json={"role": "owner"}, headers=self.h(lt))
            self.rec("G7", "Custom role with staff.manage_roles makes ITSELF owner", "403", r.status_code, r.status_code == 403)
            r = c.post(f"/auth/users/{owner_a_id}/deactivate", headers=self.h(lt))
            self.rec("G8", "Custom role with staff.deactivate deactivates the owner", "403", r.status_code, r.status_code == 403)
            if r.status_code == 200:
                c.post(f"/auth/users/{owner_a_id}/reactivate", headers=self.h(lt))
            a_tok = self.login(email=self.email("a-owner"), password=PWs).json().get("access_token", a_tok)

        # deactivation kills sessions at once
        r = c.post(f"/auth/users/{me['id']}/deactivate", headers=self.h(a_tok))
        r1 = c.get("/auth/me", headers=self.h(w_tok))
        r2 = c.post("/auth/refresh", json={"refresh_token": w_rt})
        r3 = self.login(email=w_email, password=PW)
        self.rec("D1", "Deactivated waiter: old access token", "401 at once", r1.status_code, r1.status_code == 401)
        self.rec("D2", "Deactivated waiter: refresh token", "401", r2.status_code, r2.status_code == 401)
        self.rec("D3", "Deactivated waiter: login", "401", r3.status_code, r3.status_code == 401)
        c.post(f"/auth/users/{me['id']}/reactivate", headers=self.h(a_tok))
        r4 = c.get("/auth/me", headers=self.h(w_tok))
        self.rec("D4", "Reactivated: the OLD access token from before deactivation", "401 (session stays ended)",
                 r4.status_code, r4.status_code == 401)
        # owner resets the waiter's password: old access token
        lw2 = self.login(email=w_email, password=PW)
        if lw2.status_code == 200:
            t2 = lw2.json()["access_token"]
            c.post(f"/auth/users/{me['id']}/reset-password", json={"new_password": PW2}, headers=self.h(a_tok))
            r5 = c.get("/auth/me", headers=self.h(t2))
            self.rec("D5", "Owner resets waiter password: old access token", "401 at once", r5.status_code, r5.status_code == 401)
        # restaurant code is shown to staff too (needed on their phone)
        self.rec("Z1", "No plan-based staff limit exists", "info", "no staff/user limit in entitlements", None)
        return self.checks


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:8000/api/v1")
    ap.add_argument("--out", default=None)
    a = ap.parse_args()
    checks = Run(a.base).run()
    bad = [x for x in checks if x.status == "FAIL"]
    print(f"\n{len(checks)} checks: {sum(x.status == 'pass' for x in checks)} pass, {len(bad)} FAIL, "
          f"{sum(x.status == 'unsupported' for x in checks)} unsupported")
    if a.out:
        with open(a.out, "w") as f:
            json.dump([asdict(x) for x in checks], f, indent=1)
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
