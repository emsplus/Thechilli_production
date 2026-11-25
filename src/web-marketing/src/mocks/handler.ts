// MSW-style in-process mock of marketing-service: a fetch replacement with seeded data, row scoping, duplicate
// detection (409), the pipeline rules, checklist readiness and maker-checker commissions. Enabled with
// NEXT_PUBLIC_API_MOCK=1 so the UI runs without the backend. State lives in memory (resets on reload).
import type * as T from "@/lib/api/types";
import { newId, seedDb, type MockDb, type MockUser } from "./seed";
import { allowedStages } from "@/lib/pipeline";
import { normalizePhone } from "@/lib/phone";

type Body = Record<string, unknown>;
class HttpErr extends Error { constructor(public status: number, message: string, public detail?: unknown) { super(message); } }

const ORDER: T.LeadStage[] = ["new", "contacted", "qualified", "demo_scheduled", "demo_done", "negotiation"];
const nowIso = () => new Date().toISOString();
const digits = (s?: string | null) => (s ?? "").replace(/\D/g, "");
const emailNorm = (s?: string | null) => (s ? s.trim().toLowerCase() : null);

export function createMockFetch(db: MockDb = seedDb(), latencyMs = 120): typeof fetch {
  const audit = (actor: string, action: string, entity_type: string, entity_id: string, meta: Body | null = null) =>
    db.audit.unshift({ id: newId(), actor_id: actor, action, entity_type, entity_id, meta, created_at: nowIso() });

  function me(req: Request): MockUser {
    const m = /^Bearer mock-access:(.+)$/.exec(req.headers.get("authorization") ?? "");
    const u = m && db.users.find((x) => x.id === m[1] && x.is_active);
    if (!u) throw new HttpErr(401, "Not authenticated");
    return u;
  }
  const admin = (u: MockUser) => { if (u.role !== "marketing_admin") throw new HttpErr(403, "Admin only"); };
  const sales = (u: MockUser) => { if (u.role === "onboarding_agent") throw new HttpErr(403, "Not allowed for your role"); };
  const onboard = (u: MockUser) => { if (u.role === "salesperson") throw new HttpErr(403, "Not allowed for your role"); };

  const myApps = (u: MockUser) => db.apps.filter((a) => u.role === "marketing_admin" || (u.role === "onboarding_agent" && a.agent_id === u.id) ||
    (u.role === "salesperson" && a.lead_id && visibleLeads(u).some((l) => l.id === a.lead_id)));
  function visibleLeads(u: MockUser): T.LeadOut[] {
    if (u.role === "marketing_admin") return db.leads;
    if (u.role === "salesperson") return db.leads.filter((l) => l.owner_id === u.id || l.created_by === u.id);
    const ids = new Set(db.apps.filter((a) => a.agent_id === u.id).map((a) => a.lead_id));
    return db.leads.filter((l) => ids.has(l.id));
  }
  const getLead = (u: MockUser, id: string) => visibleLeads(u).find((l) => l.id === id) ?? (() => { throw new HttpErr(404, "Lead not found"); })();
  const getApp = (u: MockUser, id: string) => myApps(u).find((a) => a.id === id) ?? (() => { throw new HttpErr(404, "Application not found"); })();

  const dups = (phone?: string | null, email?: string | null, exceptId?: string) => {
    const pn = digits(phone).slice(-10), en = emailNorm(email);
    return db.leads.filter((l) => l.id !== exceptId && ((pn.length >= 7 && digits(l.phone).slice(-10) === pn) || (en && emailNorm(l.email) === en)))
      .map((l) => ({ id: l.id, business_name: l.business_name, stage: l.stage, owner_id: l.owner_id }));
  };
  const checkPhone = (phone: unknown) => {
    try { return normalizePhone(typeof phone === "string" ? phone : null); } catch (e) {
      throw new HttpErr(422, (e as Error).message, [{ loc: ["body", "phone"], msg: "Value error, " + (e as Error).message }]);
    }
  };
  const dupErr = (d: unknown[]) => new HttpErr(409, "Possible duplicate lead", { message: "Possible duplicate lead", duplicates: d });

  function itemStatus(key: T.ChecklistKey, data: Body): T.ChecklistStatus {
    let done = true;
    if (key === "menu") done = data.ready === true && Number(data.item_count) > 0;
    if (key === "staff") done = Number(data.staff_count) > 0;
    if (key === "documents") {
      const ok = new Set(((data.documents as T.DocumentRef[]) ?? []).filter((d) => d.status === "verified").map((d) => d.type));
      done = ok.has("trade_licence") && ok.has("owner_id");
    }
    return done ? "done" : "in_progress";
  }
  function readiness(app: T.AppOut): T.Readiness {
    const items = db.checklist[app.id] ?? [];
    const blockers = items.filter((i) => i.status !== "done").map((i) => `checklist item '${i.key}' is ${i.status}`);
    if (!app.owner_name || !app.owner_email) blockers.push("owner name and owner email are required");
    return { status: app.status, ready: blockers.length === 0, blockers, items: items.map((i) => ({ key: i.key, status: i.status })) };
  }
  function refreshStatus(app: T.AppOut) {
    if (app.status === "provisioned" || app.status === "cancelled") return;
    const items = db.checklist[app.id] ?? [];
    app.status = readiness(app).ready ? "ready" : items.some((i) => i.status !== "pending") ? "in_progress" : "draft";
  }

  const activation = (a: T.AppOut): T.ActivationOut => {
    const ok = a.platform_status === "provisioned" && (a.billing_status === "trialing" || a.billing_status === "active");
    return { application_id: a.id, status: a.status, external_business_id: a.external_business_id, platform_status: a.platform_status, billing_status: a.billing_status,
      activated: ok, paying: ok && a.billing_status === "active", status_checked_at: a.status_checked_at };
  };
  const sniff = (b: Uint8Array) => (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 ? "application/pdf" : b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 ? "image/png" : b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff ? "image/jpeg" : null);
  const MAX_DOC = 5 * 1024 * 1024;
  const blobs = new Map<string, { buf: ArrayBuffer; type: string }>();
  function syncDocs(a: T.AppOut) {
    const latest = new Map<string, T.DocumentOut>();
    for (const d of db.documents.filter((x) => x.application_id === a.id).sort((p, q) => p.created_at.localeCompare(q.created_at))) latest.set(d.doc_type, d);
    const item = (db.checklist[a.id] ?? []).find((i) => i.key === "documents")!;
    item.data = { documents: [...latest.values()].map((d) => ({ type: d.doc_type, status: d.status, reference: d.id })) };
    item.status = itemStatus("documents", item.data); item.updated_at = nowIso(); refreshStatus(a);
  }
  async function docsAndActivation(u: MockUser, a: T.AppOut, sub: string, key: string | undefined, m: string, body: Body, req: Request): Promise<{ status: number; body?: unknown }> {
    if (sub === "activation") {
      onboard(u);
      if (key !== "refresh" || m !== "POST") throw new HttpErr(404, "Not found");
      if (!a.external_business_id) throw new HttpErr(409, "Application has not been submitted to the platform yet");
      // Demo: the platform advances one step each refresh, then reports a trial and finally a paid subscription.
      if (a.billing_status === "trialing" && a.platform_status === "provisioned" && Date.now() % 2 === 0) a.billing_status = "active";
      else { a.platform_status = "provisioned"; a.billing_status ??= "trialing"; }
      a.status_checked_at = nowIso(); audit(u.id, "onboarding.activation_synced", "onboarding_application", a.id, { platform_status: a.platform_status, billing_status: a.billing_status });
      return { status: 200, body: activation(a) };
    }
    const locked = () => { if (a.status === "provisioned" || a.status === "cancelled") throw new HttpErr(409, `Application is ${a.status}; documents are locked`); };
    const docId = key;
    const rest = new URL(req.url, "http://mock.local").pathname.split("/documents/")[1]?.split("/") ?? [];
    if (!rest.length || rest[0] === "") {
      if (m === "GET") return { status: 200, body: db.documents.filter((d) => d.application_id === a.id).reverse() };
      if (m === "POST") {
        onboard(u); locked();
        const q = new URL(req.url, "http://mock.local").searchParams;
        const type = q.get("type") as T.DocType, name = (q.get("filename") ?? "document").split(/[\\/]/).pop()!.replace(/[^\w.\- ]/g, "_");
        if (!["trade_licence", "owner_id", "tax_certificate", "other"].includes(type)) throw new HttpErr(422, "Unknown document type");
        const buf = (body as unknown as { __raw?: ArrayBuffer }).__raw ?? new ArrayBuffer(0);
        if (!buf.byteLength) throw new HttpErr(422, "Empty file");
        if (buf.byteLength > MAX_DOC) throw new HttpErr(413, "File too large (max 5 MB)");
        const ct = sniff(new Uint8Array(buf));
        if (!ct) throw new HttpErr(415, "Unsupported file type: only PDF, PNG and JPEG are accepted");
        const ext = (/\.[^.]+$/.exec(name)?.[0] ?? "").toLowerCase();
        if (!({ "application/pdf": [".pdf"], "image/png": [".png"], "image/jpeg": [".jpg", ".jpeg"] }[ct]).includes(ext)) throw new HttpErr(415, "File extension does not match its content");
        const d: T.DocumentOut = { id: newId(), application_id: a.id, doc_type: type, filename: name, content_type: ct, size_bytes: buf.byteLength, status: "received", created_at: nowIso() };
        db.documents.push(d); blobs.set(d.id, { buf, type: ct }); syncDocs(a);
        audit(u.id, "document.uploaded", "onboarding_application", a.id, { document_id: d.id, type, size: buf.byteLength });
        return { status: 201, body: d };
      }
    }
    void docId;
    const d = db.documents.find((x) => x.id === rest[0] && x.application_id === a.id);
    if (!d) throw new HttpErr(404, "Document not found");
    if (rest[1] === "content" && m === "GET") return { status: 200, body: { __blob: blobs.get(d.id) } };
    if (rest[1] === "decision" && m === "POST") {
      admin(u); locked();
      d.status = body.status as T.DocumentOut["status"]; syncDocs(a); audit(u.id, "document.decided", "onboarding_application", a.id, { document_id: d.id, status: d.status });
      return { status: 200, body: d };
    }
    if (!rest[1] && m === "DELETE") {
      onboard(u); locked(); db.documents.splice(db.documents.indexOf(d), 1); blobs.delete(d.id); syncDocs(a);
      return { status: 204 };
    }
    throw new HttpErr(404, "Not found");
  }

  const newToken = () => "mock-token-" + Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12);
  /** Mock delivery provider: nothing leaves the browser; addresses at @fail.example.com simulate a provider failure. */
  function deliver(inv: T.InvitationOut, u: MockUser) {
    const failed = inv.email.endsWith("@fail.example.com");
    (db.deliveries[inv.id] ??= []).push({ id: newId(), channel: "email", provider: "mock", status: failed ? "failed" : "sent", error: failed ? "mock provider: simulated failure" : null, created_at: nowIso() });
    inv.delivery_status = failed ? "failed" : "sent";
    audit(u.id, "invitation.delivery_" + inv.delivery_status, "invitation", inv.id, { provider: "mock" });
  }

  const page = <X,>(rows: X[], q: URLSearchParams) => rows.slice(Number(q.get("offset") ?? 0), Number(q.get("offset") ?? 0) + Number(q.get("limit") ?? 50));
  const pick = <X extends object>(patch: Body, allowed: (keyof X)[]) => Object.fromEntries(Object.entries(patch).filter(([k]) => (allowed as string[]).includes(k)));

  async function route(req: Request, url: URL): Promise<{ status: number; body?: unknown }> {
    const path = url.pathname.replace(/^.*\/api\/v1/, "");
    const m = req.method;
    const q = url.searchParams;
    const isJson = (req.headers.get("content-type") ?? "").includes("json");
    const body: Body = ["POST", "PUT", "PATCH"].includes(m)
      ? (isJson || !req.headers.get("content-type") ? ((await req.json().catch(() => ({}))) as Body) : ({ __raw: await req.arrayBuffer() } as Body))
      : {};
    const ok = (b: unknown, status = 200) => ({ status, body: b });
    let x: RegExpExecArray | null;
    const at = (re: RegExp) => (x = re.exec(path));

    if (m === "GET" && path === "/health") return ok({ status: "ok", version: "mock" });
    if (m === "POST" && path === "/auth/login") {
      const u = db.users.find((v) => v.email === String(body.email).toLowerCase() && v.password === body.password && v.is_active);
      if (!u) throw new HttpErr(401, "Incorrect email or password");
      return ok({ access_token: `mock-access:${u.id}`, refresh_token: `mock-refresh:${u.id}`, token_type: "bearer" });
    }
    if (m === "POST" && path === "/auth/refresh") {
      const r = /^mock-refresh:(.+)$/.exec(String(body.refresh_token));
      if (!r) throw new HttpErr(401, "Invalid refresh token");
      return ok({ access_token: `mock-access:${r[1]}`, refresh_token: `mock-refresh:${r[1]}`, token_type: "bearer" });
    }
    if (m === "POST" && path === "/auth/logout") return { status: 204 };
    const u = me(req);
    const strip = ({ password: _p, ...rest }: MockUser) => { void _p; return rest; };

    if (m === "GET" && path === "/auth/me") return ok(strip(u));
    if (m === "POST" && path === "/auth/change-password") {
      if (body.current_password !== u.password) throw new HttpErr(400, "Current password is incorrect");
      u.password = String(body.new_password);
      return { status: 204 };
    }
    // users
    if (path === "/users" && m === "GET") { admin(u); return ok(db.users.filter((v) => !q.get("role") || v.role === q.get("role")).map(strip)); }
    if (path === "/users" && m === "POST") {
      admin(u);
      const email = String(body.email).toLowerCase();
      if (db.users.some((v) => v.email === email)) throw new HttpErr(409, "Email already in use");
      const nu: MockUser = { id: newId(), email, name: String(body.name), role: body.role as T.Role, is_active: true, created_at: nowIso(), password: String(body.password) };
      db.users.push(nu); audit(u.id, "user.created", "user", nu.id);
      return ok(strip(nu), 201);
    }
    if (at(/^\/users\/([^/]+)$/)) {
      const t = db.users.find((v) => v.id === x![1]);
      if (!t || (u.role !== "marketing_admin" && t.id !== u.id)) throw new HttpErr(404, "User not found");
      if (m === "GET") return ok(strip(t));
      admin(u);
      Object.assign(t, pick<T.UserUpdate>(body, ["name", "role", "is_active", "password"]));
      audit(u.id, "user.updated", "user", t.id, { fields: Object.keys(body) });
      return ok(strip(t));
    }
    // leads
    if (path === "/leads" && m === "GET") {
      let rows = visibleLeads(u);
      const s = q.get("q")?.toLowerCase();
      if (q.get("stage")) rows = rows.filter((l) => l.stage === q.get("stage"));
      if (q.get("owner_id")) rows = rows.filter((l) => l.owner_id === q.get("owner_id"));
      if (q.get("campaign_id")) rows = rows.filter((l) => l.campaign_id === q.get("campaign_id"));
      if (q.get("unassigned") === "true") rows = rows.filter((l) => !l.owner_id);
      if (s) rows = rows.filter((l) => [l.business_name, l.contact_name, l.email, l.phone_norm].some((f) => f?.toLowerCase().includes(s.replace(/\s/g, ""))) || l.business_name.toLowerCase().includes(s));
      return ok(page([...rows].sort((a, b) => b.created_at.localeCompare(a.created_at)), q));
    }
    if (path === "/leads/duplicates" && m === "GET") { sales(u); return ok(dups(q.get("phone"), q.get("email"))); }
    if (path === "/leads" && m === "POST") {
      sales(u);
      const phoneNorm = checkPhone(body.phone);
      const d = dups(body.phone as string, body.email as string);
      if (d.length && q.get("force") !== "true") throw dupErr(d);
      if (!body.phone && !body.email) throw new HttpErr(422, "a phone or an email is required", [{ loc: ["body", "phone"], msg: "Value error, a phone or an email is required" }]);
      if (body.owner_id && u.role !== "marketing_admin" && body.owner_id !== u.id) throw new HttpErr(403, "Only an admin can assign a lead to someone else");
      const owner = (body.owner_id as string) || (u.role === "salesperson" ? u.id : null);
      const lead: T.LeadOut = {
        id: newId(), business_name: String(body.business_name), contact_name: String(body.contact_name), phone: (body.phone as string) || null,
        phone_norm: phoneNorm, email: (body.email as string) || null, city: (body.city as string) || null,
        business_type: (body.business_type as string) || null, source: (body.source as string) || "manual", stage: "new", lost_reason: null,
        notes: (body.notes as string) || null, owner_id: owner, campaign_id: (body.campaign_id as string) || null, referral_code_id: null,
        created_by: u.id, created_at: nowIso(), updated_at: nowIso(),
      };
      db.leads.unshift(lead); audit(u.id, "lead.created", "lead", lead.id, { duplicate_forced: d.length > 0 });
      return ok(lead, 201);
    }
    if (at(/^\/leads\/([^/]+)\/merge$/) && m === "POST") {
      sales(u);
      const target = getLead(u, x![1]!);
      const source = getLead(u, String(body.source_id));
      if (source.id === target.id) throw new HttpErr(422, "Cannot merge a lead into itself");
      const live = (l: T.LeadOut) => db.apps.some((a) => a.lead_id === l.id && a.status !== "cancelled");
      if (live(target) && live(source)) throw new HttpErr(409, "Both leads have an onboarding application; cancel one before merging");
      for (const list of [db.activities, db.demos, db.apps, db.invitations, db.entries] as { lead_id: string | null }[][]) for (const r of list) if (r.lead_id === source.id) r.lead_id = target.id;
      for (const f of ["phone", "phone_norm", "email", "city", "business_type", "owner_id", "campaign_id", "referral_code_id"] as const) if (target[f] == null && source[f] != null) (target as unknown as Record<string, unknown>)[f] = source[f];
      if (source.notes) target.notes = target.notes ? `${target.notes}\n\n[merged] ${source.notes}` : `[merged] ${source.notes}`;
      if (source.stage === "won") target.stage = "won";
      db.leads.splice(db.leads.indexOf(source), 1);
      audit(u.id, "lead.merged", "lead", target.id, { source_id: source.id });
      return ok(target);
    }
    if (at(/^\/leads\/([^/]+)$/)) {
      const lead = getLead(u, x![1]!);
      if (m === "GET") return ok(lead);
      sales(u);
      if (m === "DELETE") { admin(u); db.leads.splice(db.leads.indexOf(lead), 1); return { status: 204 }; }
      if ("phone" in body) checkPhone(body.phone);
      const d = dups((body.phone as string) ?? null, (body.email as string) ?? null, lead.id);
      if (d.length && q.get("force") !== "true") throw dupErr(d);
      Object.assign(lead, pick<T.LeadOut>(body, ["business_name", "contact_name", "phone", "email", "city", "business_type", "source", "notes", "campaign_id"]), { updated_at: nowIso() });
      if ("phone" in body) lead.phone_norm = checkPhone(body.phone);
      audit(u.id, "lead.updated", "lead", lead.id, { fields: Object.keys(body) });
      return ok(lead);
    }
    if (at(/^\/leads\/([^/]+)\/assign$/) && m === "POST") {
      const lead = getLead(u, x![1]!); sales(u);
      const to = (body.owner_id as string | null) ?? null;
      if (u.role === "salesperson" && !(to === u.id && lead.owner_id === null)) throw new HttpErr(403, "You can only claim an unassigned lead for yourself");
      if (to && !db.users.some((v) => v.id === to && v.is_active && v.role !== "onboarding_agent")) throw new HttpErr(422, "Unknown or inactive user");
      lead.owner_id = to; audit(u.id, "lead.assigned", "lead", lead.id, { to });
      return ok(lead);
    }
    if (at(/^\/leads\/([^/]+)\/stage$/) && m === "POST") {
      const lead = getLead(u, x![1]!); sales(u);
      const to = body.stage as T.LeadStage;
      if (!allowedStages(lead.stage).includes(to)) throw new HttpErr(409, `Cannot move from ${lead.stage} to ${to}`);
      if (to === "lost" && !body.lost_reason) throw new HttpErr(422, "A reason is required to mark a lead lost");
      lead.stage = to; lead.lost_reason = to === "lost" ? String(body.lost_reason) : null; lead.updated_at = nowIso();
      audit(u.id, "lead.stage", "lead", lead.id, { to });
      return ok(lead);
    }
    if (at(/^\/leads\/([^/]+)\/activities$/)) {
      const lead = getLead(u, x![1]!);
      if (m === "GET") return ok(db.activities.filter((a) => a.lead_id === lead.id).sort((a, b) => b.created_at.localeCompare(a.created_at)));
      sales(u);
      const a: T.ActivityOut = { id: newId(), lead_id: lead.id, type: body.type as T.ActivityType, summary: String(body.summary), due_at: (body.due_at as string) || null,
        completed_at: body.completed ? nowIso() : null, assignee_id: (body.assignee_id as string) || u.id, created_by: u.id, created_at: nowIso() };
      db.activities.push(a); audit(u.id, "activity.created", "activity", a.id);
      return ok(a, 201);
    }
    if (at(/^\/leads\/([^/]+)\/demos$/) && m === "POST") {
      const lead = getLead(u, x![1]!); sales(u);
      const assignee = (body.assignee_id as string) || u.id;
      const start = new Date(String(body.scheduled_at)).getTime(), dur = Number(body.duration_minutes ?? 30) * 60_000;
      if (db.demos.some((d) => d.assignee_id === assignee && d.status === "scheduled" && new Date(d.scheduled_at).getTime() < start + dur && start < new Date(d.scheduled_at).getTime() + d.duration_minutes * 60_000))
        throw new HttpErr(409, "That time overlaps another demo for the assignee");
      const d: T.DemoOut = { id: newId(), lead_id: lead.id, assignee_id: assignee, scheduled_at: new Date(start).toISOString(), duration_minutes: Number(body.duration_minutes ?? 30),
        mode: String(body.mode ?? "online"), location: (body.location as string) || null, status: "scheduled", outcome_notes: null, created_at: nowIso() };
      db.demos.push(d);
      if (ORDER.indexOf(lead.stage) >= 0 && ORDER.indexOf(lead.stage) < ORDER.indexOf("demo_scheduled")) lead.stage = "demo_scheduled";
      audit(u.id, "demo.created", "demo", d.id);
      return ok(d, 201);
    }
    // activities & demos
    if (path === "/activities" && m === "GET") {
      const st = q.get("status") ?? "pending", mine = q.get("mine") !== "false" || u.role !== "marketing_admin";
      const lids = new Set(visibleLeads(u).map((l) => l.id));
      let rows = db.activities.filter((a) => lids.has(a.lead_id) && (!mine || a.assignee_id === u.id || a.created_by === u.id));
      const now = Date.now();
      if (st === "pending") rows = rows.filter((a) => !a.completed_at && a.due_at);
      if (st === "overdue") rows = rows.filter((a) => !a.completed_at && a.due_at && new Date(a.due_at).getTime() < now);
      if (st === "completed") rows = rows.filter((a) => a.completed_at);
      if (q.get("due_before")) rows = rows.filter((a) => a.due_at && new Date(a.due_at) <= new Date(q.get("due_before")!));
      return ok(rows.sort((a, b) => (a.due_at ?? "9").localeCompare(b.due_at ?? "9")).slice(0, Number(q.get("limit") ?? 100)));
    }
    if (at(/^\/activities\/([^/]+)\/complete$/) && m === "POST") {
      const a = db.activities.find((v) => v.id === x![1]);
      if (!a) throw new HttpErr(404, "Activity not found");
      getLead(u, a.lead_id);
      if (a.completed_at) throw new HttpErr(409, "Activity is already completed");
      a.completed_at = nowIso();
      return ok(a);
    }
    if (path === "/demos" && m === "GET") {
      const lids = new Set(visibleLeads(u).map((l) => l.id));
      let rows = db.demos.filter((d) => lids.has(d.lead_id) && (u.role === "marketing_admin" || d.assignee_id === u.id));
      if (q.get("status")) rows = rows.filter((d) => d.status === q.get("status"));
      if (q.get("lead_id")) rows = rows.filter((d) => d.lead_id === q.get("lead_id"));
      if (q.get("assignee_id")) rows = rows.filter((d) => d.assignee_id === q.get("assignee_id"));
      if (q.get("start")) rows = rows.filter((d) => d.scheduled_at >= new Date(q.get("start")!).toISOString());
      if (q.get("end")) rows = rows.filter((d) => d.scheduled_at <= new Date(q.get("end")!).toISOString());
      return ok(rows.sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at)));
    }
    if (at(/^\/demos\/([^/]+)$/) && m === "PATCH") {
      const d = db.demos.find((v) => v.id === x![1]);
      if (!d) throw new HttpErr(404, "Demo not found");
      const lead = getLead(u, d.lead_id); sales(u);
      Object.assign(d, pick<T.DemoOut>(body, ["scheduled_at", "duration_minutes", "location", "status", "outcome_notes", "assignee_id"]));
      if (body.status === "completed" && lead.stage === "demo_scheduled") lead.stage = "demo_done";
      return ok(d);
    }
    // onboarding
    if (path === "/onboarding/applications" && m === "GET") {
      let rows = myApps(u);
      if (q.get("status")) rows = rows.filter((a) => a.status === q.get("status"));
      if (q.get("agent_id")) rows = rows.filter((a) => a.agent_id === q.get("agent_id"));
      return ok(page(rows, q));
    }
    if (path === "/onboarding/applications" && m === "POST") {
      if (u.role === "salesperson") throw new HttpErr(403, "Not allowed for your role");
      const lead = body.lead_id ? db.leads.find((l) => l.id === body.lead_id) : undefined;
      if (!lead && !body.business_name) throw new HttpErr(422, "business_name is required without a lead_id");
      const a: T.AppOut = { id: newId(), lead_id: lead?.id ?? null, agent_id: u.role === "onboarding_agent" ? u.id : (body.agent_id as string) || null, source: "assisted", status: "draft",
        business_name: (body.business_name as string) || lead!.business_name, owner_name: (body.owner_name as string) || lead?.contact_name || null, owner_email: (body.owner_email as string) || lead?.email || null,
        owner_phone: (body.owner_phone as string) || lead?.phone || null, referral_code_id: null, contract_value_minor: u.role === "marketing_admin" ? Number(body.contract_value_minor ?? 0) : 0,
        currency: "INR", external_business_id: null, provisioning_error: null, provisioned_at: null, platform_status: null, billing_status: null, status_checked_at: null, created_at: nowIso() };
      db.apps.unshift(a);
      db.checklist[a.id] = (["business_type", "outlet", "menu", "staff", "documents"] as T.ChecklistKey[]).map((k) => ({ key: k, status: "pending", data: {}, updated_at: nowIso() }));
      refreshStatus(a); audit(u.id, "onboarding.created", "onboarding_application", a.id);
      return ok(a, 201);
    }
    if (at(/^\/onboarding\/applications\/([^/]+)(?:\/([a-z]+))?(?:\/([^/]+))?(?:\/[a-z]+)?$/)) {
      const [, id, sub, key] = x!;
      const a = getApp(u, id!);
      if (!sub && m === "GET") return ok(a);
      if (!sub && m === "PATCH") {
        onboard(u);
        const patch = pick<T.AppUpdate>(body, ["business_name", "owner_name", "owner_email", "owner_phone", "contract_value_minor"]);
        if ("contract_value_minor" in patch && u.role !== "marketing_admin") throw new HttpErr(403, "Only an admin can set the contract value");
        Object.assign(a, patch); refreshStatus(a); return ok(a);
      }
      if (sub === "assign" && m === "POST") { admin(u); a.agent_id = (body.agent_id as string) ?? null; return ok(a); }
      if (sub === "checklist" && !key && m === "GET") return ok(db.checklist[a.id] ?? []);
      if (sub === "checklist" && key && m === "PUT") {
        onboard(u);
        if (a.status === "provisioned" || a.status === "cancelled") throw new HttpErr(409, `Application is ${a.status}; checklist is locked`);
        const item = (db.checklist[a.id] ?? []).find((i) => i.key === key);
        if (!item) throw new HttpErr(404, "Unknown checklist item");
        item.data = body; item.status = itemStatus(key as T.ChecklistKey, body); item.updated_at = nowIso(); refreshStatus(a);
        return ok(item);
      }
      if (sub === "readiness" && m === "GET") return ok(readiness(a));
      if (sub === "provision" && m === "POST") {
        onboard(u);
        if (a.status === "provisioned") return ok(a);
        if (!readiness(a).ready) throw new HttpErr(409, "Application is not ready: " + readiness(a).blockers.join("; "));
        a.status = "provisioned"; a.external_business_id = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(16)}-0000-4000-8000-000000000000`; a.provisioned_at = nowIso(); a.platform_status = "received";
        const lead = a.lead_id ? db.leads.find((l) => l.id === a.lead_id) : undefined;
        if (lead) lead.stage = "won";
        for (const r of db.rules.filter((v) => v.is_active)) {
          const user = r.recipient === "lead_owner" ? lead?.owner_id : r.recipient === "application_agent" ? a.agent_id : null;
          if (!user) continue;
          const amount = r.calc === "flat" ? r.flat_amount_minor : Math.min(Math.floor((a.contract_value_minor * r.rate_bps + 5000) / 10000), r.cap_minor ?? Infinity);
          db.entries.unshift({ id: newId(), kind: "commission", rule_id: r.id, user_id: user, application_id: a.id, lead_id: a.lead_id, base_amount_minor: a.contract_value_minor, amount_minor: amount,
            currency: a.currency, status: "pending", reverses_entry_id: null, decided_by: null, decided_at: null, note: null, created_at: nowIso() });
        }
        audit(u.id, "onboarding.provisioned", "onboarding_application", a.id);
        return ok(a);
      }
      if (sub === "activation" && m === "GET") return ok(activation(a));
      if (sub === "documents" || sub === "activation") return docsAndActivation(u, a, sub, key, m, body, req);
      if (sub === "cancel" && m === "POST") {
        onboard(u);
        if (a.status === "provisioned" || a.status === "cancelled") throw new HttpErr(409, `Application is already ${a.status}`);
        a.status = "cancelled"; return ok(a);
      }
    }
    // invitations
    if (path === "/invitations" && m === "GET") {
      const lids = new Set(visibleLeads(u).map((l) => l.id)), aids = new Set(myApps(u).map((a) => a.id));
      return ok(db.invitations.filter((i) => u.role === "marketing_admin" || (i.lead_id && lids.has(i.lead_id)) || (i.application_id && aids.has(i.application_id))));
    }
    if (path === "/invitations" && m === "POST") {
      const inv: T.InvitationOut = { id: newId(), email: String(body.email).toLowerCase(), lead_id: (body.lead_id as string) || null, application_id: (body.application_id as string) || null, referral_code_id: null,
        expires_at: new Date(Date.now() + Number(body.ttl_hours ?? 72) * 3_600_000).toISOString(), used_at: null, revoked_at: null, created_at: nowIso(), delivery_status: null };
      db.invitations.unshift(inv); audit(u.id, "invitation.created", "invitation", inv.id);
      if (body.send) deliver(inv, u);
      return ok({ ...inv, token: newToken() }, 201);
    }
    if (at(/^\/invitations\/([^/]+)\/(revoke|resend|deliveries)$/)) {
      const inv = db.invitations.find((i) => i.id === x![1]);
      const visible = inv && (u.role === "marketing_admin" || visibleLeads(u).some((l) => l.id === inv.lead_id) || myApps(u).some((a) => a.id === inv.application_id));
      if (!inv || !visible) throw new HttpErr(404, "Invitation not found");
      if (x![2] === "deliveries" && m === "GET") return ok([...(db.deliveries[inv.id] ?? [])].reverse());
      if (m !== "POST") throw new HttpErr(404, "Not found");
      if (inv.used_at || inv.revoked_at) throw new HttpErr(409, "Invitation is already used or revoked");
      if (x![2] === "revoke") { inv.revoked_at = nowIso(); return ok(inv); }
      inv.expires_at = new Date(Date.now() + 72 * 3_600_000).toISOString();
      deliver(inv, u);
      return ok({ ...inv, token: newToken() });
    }
    // referrals
    if (path === "/referral-codes" && m === "GET") { sales2(u); return ok(db.referrals.filter((r) => u.role === "marketing_admin" || r.owner_id === u.id)); }
    if (path === "/referral-codes" && m === "POST") {
      sales2(u);
      const code = String(body.code || Math.random().toString(36).slice(2, 10)).toUpperCase();
      if (db.referrals.some((r) => r.code === code)) throw new HttpErr(409, "Code already exists");
      const r: T.ReferralOut = { id: newId(), code, owner_id: u.role === "marketing_admin" && body.owner_id ? String(body.owner_id) : u.id, campaign_id: (body.campaign_id as string) || null,
        is_active: true, max_uses: (body.max_uses as number) ?? null, expires_at: (body.expires_at as string) ?? null, created_at: nowIso(), uses: 0 };
      db.referrals.unshift(r); return ok(r, 201);
    }
    if (at(/^\/referral-codes\/([^/]+)(\/attributions)?$/)) {
      const r = db.referrals.find((v) => v.id === x![1] && (u.role === "marketing_admin" || v.owner_id === u.id));
      if (!r) throw new HttpErr(404, "Referral code not found");
      if (x![2]) return ok(db.attributions.filter((a) => a.referral_code_id === r.id));
      Object.assign(r, pick<T.ReferralUpdate>(body, ["is_active", "max_uses", "expires_at"])); return ok(r);
    }
    // campaigns
    if (path === "/campaigns" && m === "GET") return ok(db.campaigns);
    if (path === "/campaigns" && m === "POST") {
      admin(u);
      if (db.campaigns.some((c) => c.name === body.name)) throw new HttpErr(409, "A campaign with this name exists");
      const c: T.CampaignOut = { id: newId(), name: String(body.name), channel: String(body.channel), status: (body.status as T.CampaignStatus) ?? "draft", budget_minor: Number(body.budget_minor ?? 0),
        currency: "INR", starts_on: (body.starts_on as string) ?? null, ends_on: (body.ends_on as string) ?? null, created_at: nowIso() };
      db.campaigns.unshift(c); return ok(c, 201);
    }
    if (at(/^\/campaigns\/([^/]+)(\/stats)?$/)) {
      const c = db.campaigns.find((v) => v.id === x![1]);
      if (!c) throw new HttpErr(404, "Campaign not found");
      if (x![2]) {
        sales(u);
        const by = Object.fromEntries(([...ORDER, "won", "lost"] as T.LeadStage[]).map((s) => [s, 0])) as Record<T.LeadStage, number>;
        const ls = db.leads.filter((l) => l.campaign_id === c.id); ls.forEach((l) => by[l.stage]++);
        return ok({ campaign_id: c.id, leads: ls.length, by_stage: by, won: by.won, conversion_bps: ls.length ? Math.floor((by.won * 10000) / ls.length) : 0,
          cost_per_lead_minor: ls.length ? Math.floor(c.budget_minor / ls.length) : null, referral_attributions: 0, currency: c.currency } satisfies T.CampaignStats);
      }
      if (m === "PATCH") { admin(u); Object.assign(c, pick<T.CampaignUpdate>(body, ["name", "channel", "status", "budget_minor", "starts_on", "ends_on"])); }
      return ok(c);
    }
    // commissions
    if (path === "/commission-rules") {
      if (m === "GET") return ok(db.rules);
      admin(u);
      const r: T.RuleOut = { id: newId(), name: String(body.name), recipient: body.recipient as T.Recipient, calc: body.calc as T.Calc, flat_amount_minor: Number(body.flat_amount_minor ?? 0),
        rate_bps: Number(body.rate_bps ?? 0), cap_minor: (body.cap_minor as number) ?? null, min_base_minor: Number(body.min_base_minor ?? 0), currency: "INR", is_active: true, valid_from: null, valid_to: null };
      db.rules.push(r); return ok(r, 201);
    }
    if (at(/^\/commission-rules\/([^/]+)$/) && m === "PATCH") {
      admin(u);
      const r = db.rules.find((v) => v.id === x![1]);
      if (!r) throw new HttpErr(404, "Rule not found");
      Object.assign(r, pick<T.RuleUpdate>(body, ["is_active", "valid_to", "cap_minor"])); return ok(r);
    }
    if (path === "/commission-entries" && m === "GET") {
      let rows = u.role === "marketing_admin" ? db.entries : db.entries.filter((e) => e.user_id === u.id);
      if (q.get("status")) rows = rows.filter((e) => e.status === q.get("status"));
      if (q.get("user_id") && u.role === "marketing_admin") rows = rows.filter((e) => e.user_id === q.get("user_id"));
      return ok(page(rows, q));
    }
    if (path === "/commission-entries/summary" && m === "GET") {
      const target = u.role === "marketing_admin" && q.get("user_id") ? q.get("user_id")! : u.id;
      const balances: T.CommissionSummary["balances"] = {};
      for (const e of db.entries.filter((v) => v.user_id === target)) {
        const b = (balances[e.currency] ??= { pending_minor: 0, approved_minor: 0, paid_minor: 0 });
        if (e.status === "pending" || e.status === "approved" || e.status === "paid") b[`${e.status}_minor`] += e.amount_minor;
      }
      return ok({ user_id: target, balances });
    }
    if (at(/^\/commission-entries\/([^/]+)\/(approve|reject|pay|reverse)$/) && m === "POST") {
      admin(u);
      const e = db.entries.find((v) => v.id === x![1]);
      if (!e) throw new HttpErr(404, "Entry not found");
      const act = x![2]!;
      if (act === "reverse") {
        if (e.kind !== "commission" || !["approved", "paid"].includes(e.status)) throw new HttpErr(409, "Only approved or paid commission entries can be reversed");
        if (db.entries.some((v) => v.reverses_entry_id === e.id)) throw new HttpErr(409, "Entry has already been reversed");
        const rev: T.EntryOut = { ...e, id: newId(), kind: "reversal", rule_id: null, amount_minor: -e.amount_minor, status: "approved", reverses_entry_id: e.id, decided_by: u.id, decided_at: nowIso(), note: (body.note as string) ?? null, created_at: nowIso() };
        db.entries.unshift(rev); audit(u.id, "commission.reversed", "commission_entry", e.id);
        return ok(rev, 201);
      }
      if (e.user_id === u.id) throw new HttpErr(403, "You cannot decide on your own commission (maker-checker)");
      const from = act === "pay" ? "approved" : "pending", to = ({ approve: "approved", reject: "rejected", pay: "paid" } as const)[act as "approve" | "reject" | "pay"];
      if (e.kind !== "commission" || e.status !== from) throw new HttpErr(409, `Entry is ${e.status}; expected ${from}`);
      e.status = to; e.decided_by = u.id; e.decided_at = nowIso(); e.note = (body.note as string) || e.note;
      audit(u.id, `commission.${to}`, "commission_entry", e.id, { amount_minor: e.amount_minor });
      return ok(e);
    }
    if (path === "/audit-log" && m === "GET") {
      admin(u);
      let rows = db.audit;
      for (const k of ["entity_type", "entity_id", "actor_id", "action"] as const) if (q.get(k)) rows = rows.filter((a) => a[k] === q.get(k));
      return ok(page(rows, q));
    }
    throw new HttpErr(404, "Not found");
  }
  const sales2 = (u: MockUser) => { if (u.role === "onboarding_agent") throw new HttpErr(403, "Not allowed for your role"); };

  return async (input, init) => {
    const req = new Request(input as RequestInfo, init);
    if (latencyMs) await new Promise((r) => setTimeout(r, latencyMs));
    try {
      const { status, body } = await route(req, new URL(req.url, "http://mock.local"));
      const blob = (body as { __blob?: { buf: ArrayBuffer; type: string } } | undefined)?.__blob;
      if (blob) return new Response(blob.buf, { status, headers: { "Content-Type": blob.type } });
      return status === 204 ? new Response(null, { status }) : Response.json(body, { status });
    } catch (e) {
      if (!(e instanceof HttpErr)) throw e;
      const detail = e.detail ?? e.message;
      return Response.json({ detail, error: { code: e.status === 409 ? "conflict" : "error", message: e.message, details: null } }, { status: e.status });
    }
  };
}
