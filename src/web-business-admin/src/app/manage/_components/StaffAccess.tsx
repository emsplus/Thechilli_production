"use client";

/**
 * Staff sign-in wiring (pos-service docs/STAFF_WIRING_CHECK.md): add a staff member with an email OR a phone / username,
 * the outlets they work in, and how they get their password (one-time password shown once, an emailed invite, or a password
 * you choose); the one-time "sign-in card" (restaurant code + login id + password: copy, print, WhatsApp); outlet access.
 * English only (owner decision: languages off), like the register page.
 */
import { useEffect, useState } from "react";
import { Check, Copy, MessageCircle, Printer } from "lucide-react";
import { Button, Checkbox, Dialog, Input, Notice } from "@chilli/ui";
import { toast } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { useCan } from "@/lib/useRole";
import { cn } from "@/lib/cn";
import type { Outlet, Role, StaffCredentials, StaffMember } from "@/lib/types";

const em = (e: unknown, fb: string) => (e instanceof ApiError ? e.message : fb);

/** What the person types next to the restaurant code: phone, else username, else email. */
export const loginIdOf = (u: Pick<StaffMember, "phone" | "username" | "email">) => u.phone || u.username || u.email || "";

/** Phone (digits, spaces, +, -) or username (letters first). Empty = not given. */
export function splitLoginId(v: string): { phone?: string; username?: string } {
  const s = v.trim();
  if (!s) return {};
  return /^\+?[0-9 ()\-.]+$/.test(s) ? { phone: s } : { username: s };
}

function cardText(c: StaffCredentials): string {
  const lines = [`${c.full_name}: sign in to TheChilli.ai (waiter app or counter)`, `Restaurant code: ${c.restaurant_code}`, `Phone / username: ${c.login_identifier}`];
  if (c.temporary_password) lines.push(`One-time password: ${c.temporary_password}`, "You will choose your own password after signing in.");
  if (c.invite_url) lines.push(`Choose your password here: ${c.invite_url}`);
  return lines.join("\n");
}

/** The sign-in card, shown ONCE after adding a staff member or generating a one-time password. */
export function CredentialsDialog({ creds, onClose }: { creds: StaffCredentials | null; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const [last, setLast] = useState<StaffCredentials | null>(null);
  useEffect(() => { if (creds) void Promise.resolve().then(() => { setLast(creds); setCopied(false); }); }, [creds]);
  const c = creds ?? last;
  async function copy() {
    if (!c) return;
    try { await navigator.clipboard.writeText(cardText(c)); setCopied(true); toast.success("Copied"); }
    catch { toast.error("Could not copy: select the text and copy it"); }
  }
  function print() {
    if (!c) return;
    const w = window.open("", "_blank", "width=420,height=520");
    if (!w) { toast.error("Allow pop-ups to print the card"); return; }
    w.opener = null;
    w.document.title = "Staff sign-in card";
    const pre = w.document.createElement("pre");
    pre.style.cssText = "font:16px/1.6 system-ui,sans-serif;white-space:pre-wrap;padding:24px";
    pre.textContent = cardText(c);
    w.document.body.appendChild(pre);
    w.print();
  }
  // WhatsApp placeholder: opens WhatsApp with the text; nothing is sent by the server.
  const wa = c ? `https://wa.me/?text=${encodeURIComponent(cardText(c))}` : "#";
  return (
    <Dialog open={!!creds} onOpenChange={(o) => { if (!o) onClose(); }} title="Sign-in card" description="Shown only now. Hand it over, print it or send it on WhatsApp before you close this."
      footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
      {c && (
        <div className="space-y-3 py-2" data-testid="credentials-card">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-xl border border-border bg-surface-2/60 p-4 text-sm">
            <dt className="text-fg-muted">Name</dt><dd className="font-semibold text-fg">{c.full_name}</dd>
            <dt className="text-fg-muted">Restaurant code</dt><dd className="font-mono text-lg font-bold tracking-widest text-fg" data-testid="cred-code">{c.restaurant_code}</dd>
            <dt className="text-fg-muted">Phone / username</dt><dd className="font-mono text-fg" data-testid="cred-login">{c.login_identifier}</dd>
            {c.temporary_password && <><dt className="text-fg-muted">One-time password</dt><dd className="font-mono text-lg font-bold text-fg" data-testid="cred-password">{c.temporary_password}</dd></>}
          </dl>
          {c.temporary_password && <Notice tone="info">They will be asked to choose their own password after signing in. You will not see this password again.</Notice>}
          {c.invite_url && <Notice tone={c.invite_sent ? "success" : "info"}>{c.invite_sent ? "We emailed them a link to choose their password. You can also share it:" : "Email is not set up: share this single-use link with them:"} <span className="break-all font-mono text-xs" data-testid="cred-invite">{c.invite_url}</span></Notice>}
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" iconStart={copied ? <Check /> : <Copy />} onClick={() => void copy()}>Copy</Button>
            <Button variant="secondary" iconStart={<Printer />} onClick={print}>Print</Button>
            <a href={wa} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-border px-4 text-sm font-semibold text-fg hover:bg-surface-2"><MessageCircle className="size-4" />WhatsApp</a>
          </div>
        </div>
      )}
    </Dialog>
  );
}

function OutletPicker({ outlets, value, onChange }: { outlets: Outlet[]; value: string[]; onChange: (ids: string[]) => void }) {
  return (
    <fieldset className="space-y-2" data-testid="outlet-picker">
      <legend className="mb-1.5 text-sm font-semibold text-fg">Outlets they work in</legend>
      {outlets.map((o) => (
        <Checkbox key={o.id} label={`${o.name}${o.is_default ? " (main)" : ""}`} checked={value.includes(o.id)}
          onChange={(e) => onChange(e.target.checked ? [...value, o.id] : value.filter((x) => x !== o.id))} />
      ))}
      <p className="text-xs text-fg-muted">None ticked = the main outlet only. Owners and managers always reach every outlet.</p>
    </fieldset>
  );
}

type Mode = "temporary" | "invite" | "password";

/** Add staff: name, email and/or phone / username, role, outlets, how they get their password. */
export function AddStaffDialog({ open, onClose, onDone, roles, rolePicker }: {
  open: boolean; onClose: () => void; onDone: (c: StaffCredentials | null) => void; roles: Role[];
  rolePicker: (value: Role, onChange: (r: Role) => void, allowed: Role[]) => React.ReactNode;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [loginId, setLoginId] = useState("");
  const [role, setRole] = useState<Role>("waiter");
  const [mode, setMode] = useState<Mode>("temporary");
  const [password, setPassword] = useState("");
  const [outlets, setOutlets] = useState<Outlet[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    void Promise.resolve().then(() => { setName(""); setEmail(""); setLoginId(""); setRole("waiter"); setMode("temporary"); setPassword(""); setPicked([]); setErr(null); });
    let off = false;
    void api.outlets().then((o) => { if (!off) setOutlets(o.filter((x) => x.is_active)); }, () => { if (!off) setOutlets([]); });
    return () => { off = true; };
  }, [open]);

  async function save() {
    setErr(null);
    if (!name.trim()) { setErr("Enter their name"); return; }
    if (!email.trim() && !loginId.trim()) { setErr("Give an email, or a phone number or username (staff without email sign in with the restaurant code)"); return; }
    if (mode === "invite" && !email.trim()) { setErr("An emailed invite needs their email address"); return; }
    if (mode === "password" && password.length < 10) { setErr("The password needs at least 10 characters"); return; }
    setBusy(true);
    try {
      const r = await api.createStaff({
        full_name: name.trim(), role, email: email.trim() || null, ...splitLoginId(loginId),
        password: mode === "password" ? password : null, send_invite: mode === "invite", outlet_ids: picked,
      });
      toast.success(`${r.full_name} added`);
      onClose();
      onDone(mode === "password" ? null : { full_name: r.full_name, restaurant_code: r.restaurant_code, login_identifier: r.login_identifier,
        temporary_password: r.temporary_password, invite_url: r.invite?.url ?? null, invite_sent: r.invite?.sent });
    } catch (e) { setErr(em(e, "Could not add the staff member")); } finally { setBusy(false); }
  }

  const modes: { v: Mode; label: string; hint: string }[] = [
    { v: "temporary", label: "One-time password (recommended)", hint: "We make one and show it once; they choose their own after signing in." },
    { v: "invite", label: "Email them an invite", hint: "A single-use link to choose their password (needs their email)." },
    { v: "password", label: "I will set a password", hint: "You choose it and tell them." },
  ];
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }} title="Add staff" description="Staff sign in to this restaurant only: with the restaurant code plus their phone or username, or with their email."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={() => void save()}>Add staff</Button></>}>
      <form noValidate className="space-y-4 py-2" onSubmit={(e) => { e.preventDefault(); void save(); }} data-testid="add-staff-form">
        {err && <Notice tone="danger">{err}</Notice>}
        <Input label="Full name" autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />
        <Input label="Phone or username" autoComplete="off" inputMode="text" hint="For staff without email, e.g. 98765 43210 or ramesh" value={loginId} onChange={(e) => setLoginId(e.target.value)} />
        <Input label="Email (optional)" type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />
        {rolePicker(role, setRole, roles)}
        {outlets.length > 1 && <OutletPicker outlets={outlets} value={picked} onChange={setPicked} />}
        <fieldset className="space-y-2">
          <legend className="mb-1.5 text-sm font-semibold text-fg">Password</legend>
          {modes.map((m) => (
            <label key={m.v} className={cn("flex cursor-pointer items-start gap-3 rounded-xl border p-3", mode === m.v ? "border-primary bg-primary-soft/60" : "border-border bg-surface")}>
              <input type="radio" name="cred-mode" value={m.v} checked={mode === m.v} onChange={() => setMode(m.v)} className="mt-1 size-4 accent-[var(--primary)]" />
              <span><span className="block text-sm font-semibold text-fg">{m.label}</span><span className="block text-xs text-fg-muted">{m.hint}</span></span>
            </label>
          ))}
          {mode === "password" && <Input label="Password" autoComplete="new-password" spellCheck={false} hint="At least 10 characters" value={password} onChange={(e) => setPassword(e.target.value)} />}
        </fieldset>
      </form>
    </Dialog>
  );
}

/** Which outlets a staff member works in (owners / managers reach all outlets anyway). */
export function OutletAccessDialog({ user, onClose }: { user: StaffMember | null; onClose: () => void }) {
  const { biz } = useCan();
  const [outlets, setOutlets] = useState<Outlet[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!user) return;
    let off = false;
    void Promise.resolve().then(() => setErr(null));
    void Promise.all([api.outlets(), api.userOutlets(user.id)]).then(([o, a]) => { if (!off) { setOutlets(o); setPicked(a.outlet_ids); setAll(a.access_all); } },
      (e) => { if (!off) setErr(em(e, "Could not load outlets")); });
    return () => { off = true; };
  }, [user]);
  async function save() {
    if (!user) return;
    setBusy(true); setErr(null);
    try { await api.setUserOutlets(user.id, picked); toast.success(`Outlets saved for ${user.full_name}`); onClose(); }
    catch (e) { setErr(em(e, "Could not save")); } finally { setBusy(false); }
  }
  return (
    <Dialog open={!!user} onOpenChange={(o) => { if (!o) onClose(); }} title={user ? `Outlets for ${user.full_name}` : "Outlets"}
      description={`They only see orders, ${biz.tables ? "tables " : ""}and kitchen tickets of these outlets.`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={all} onClick={() => void save()}>Save</Button></>}>
      <div className="space-y-3 py-2">
        {err && <Notice tone="danger">{err}</Notice>}
        {all ? <Notice tone="info">This role reaches every outlet.</Notice> : <OutletPicker outlets={outlets} value={picked} onChange={setPicked} />}
      </div>
    </Dialog>
  );
}
