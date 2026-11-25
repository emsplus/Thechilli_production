"use client";

import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { motion } from "motion/react";
import { Building2, Check, Copy, Hash, KeyRound, Plus, RefreshCw, ShieldCheck, UserCheck, UserCog, UserX } from "lucide-react";
import { Badge, Button, Dialog, Input, Notice, type BadgeTone } from "@chilli/ui";
import { Card, EmptyState, PillTabs, Skeleton, toast, useConfirm } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useSignOut } from "@/lib/useSignOut";
import { formatDate } from "@/lib/datetime";
import { useLoader } from "@/lib/useLoader";
import type { Role, RoleDef, StaffCredentials, StaffMember } from "@/lib/types";
import { pwSchema } from "@/lib/passwords";
import { hasPerm, isUnsupported, loadRoles } from "@/lib/roles";
import { RolesPanel } from "./RolesPanel";
import { AttendanceView } from "@/components/manage/AttendanceView";
import { useMsg } from "@/lib/i18n";
import { AUTH_MSG } from "@/components/auth/messages";
import { fieldError } from "@/components/auth/validation";
import { useManage } from "./manage-context";
import { ROLE_INFO_MSG, STAFF_MSG } from "./staff-messages";
import { AddStaffDialog, CredentialsDialog, OutletAccessDialog, loginIdOf } from "./StaffAccess";
import { StaffPinDialog } from "@/components/devices/StaffPinDialog";
import { canManagePinOf, may, PERM_PIN } from "@/lib/devices";

const fetchStaff = () => api.staff();
const ROLES: Role[] = ["owner", "manager", "cashier", "waiter", "kitchen"];
const ROLE_TONE: Record<Role, BadgeTone> = { owner: "primary", manager: "info", cashier: "success", waiter: "warning", kitchen: "neutral" };
const em = (e: unknown, fb: string) => (e instanceof ApiError ? e.message : fb);

/** Readable random password (no 0/O/1/l confusion), from the browser's secure RNG. */
function generatePassword(len = 14): string {
  const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const buf = new Uint32Array(len);
  crypto.getRandomValues(buf);
  return Array.from(buf, (n) => chars[n % chars.length]).join("");
}

const initials = (n: string) => n.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("") || "·";

function RolePills({ value, onChange, allowed }: { value: Role | null; onChange: (r: Role) => void; allowed: Role[] }) {
  const t = useMsg(STAFF_MSG);
  const tr = useMsg(ROLE_INFO_MSG);
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1.5 text-sm font-semibold text-fg">{t("role")}</legend>
      {allowed.map((r) => (
        <label key={r} className={cn("flex min-h-14 cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring", value === r ? "border-primary bg-primary-soft/60" : "border-border bg-surface hover:bg-surface-2")}>
          <input type="radio" name="role" value={r} checked={value === r} onChange={() => onChange(r)} className="mt-1 size-4 accent-[var(--primary)]" />
          <span><span className="block text-sm font-semibold text-fg">{tr(`${r}.label`)}</span><span className="block text-xs text-fg-muted">{tr(`${r}.blurb`)}</span></span>
        </label>
      ))}
    </fieldset>
  );
}

/** Staff: people, roles & permissions, and attendance (new, inside Staff like the original's single Staff section). */
export function StaffTab({ view: v, onView }: { view?: string; onView?: (v: string) => void } = {}) {
  const { me } = useManage();
  const t = useMsg(STAFF_MSG);
  const [own, setOwn] = useState<"people" | "roles" | "attendance">("people");
  const view = v === "roles" || v === "attendance" ? v : onView ? "people" : own;
  const setView = (x: "people" | "roles" | "attendance") => (onView ? onView(x) : setOwn(x));
  const canRoles = hasPerm(me, "roles.manage", me.role === "owner");
  return (
    <div className="space-y-5">
      <PillTabs label={t("tabsLabel")} value={view} onChange={setView} options={[{ value: "people", label: t("tabPeople") }, { value: "roles", label: t("tabRoles") }, { value: "attendance", label: "Attendance" }]} />
      {view === "people" ? <PeopleView /> : view === "roles" ? <RolesPanel canManage={canRoles} /> : <AttendanceView embedded />}
    </div>
  );
}

function PeopleView() {
  const { me, isOwner, refresh } = useManage();
  const t = useMsg(STAFF_MSG);
  const tr = useMsg(ROLE_INFO_MSG);
  const canCreate = hasPerm(me, "staff.create", true);
  const canRoles = hasPerm(me, "users.manage", isOwner) || hasPerm(me, "staff.manage_roles", false);
  const canReset = hasPerm(me, "staff.reset_password", isOwner);
  const canDeactivate = hasPerm(me, "staff.deactivate", isOwner);
  // Counter PINs (docs/STAFF_PIN_DEVICES_API.md 4): staff.pin.manage; an owner's PIN only by an owner (canManagePinOf).
  const canPins = may(me, PERM_PIN);
  const anyAdmin = canRoles || canReset || canDeactivate || canPins;
  const [pinFor, setPinFor] = useState<StaffMember | null>(null);
  const confirm = useConfirm();
  const { data, error, loading, reload } = useLoader(fetchStaff);
  const [addOpen, setAddOpen] = useState(false);
  const [roleFor, setRoleFor] = useState<StaffMember | null>(null);
  const [pwOpen, setPwOpen] = useState(false);
  const [customNames, setCustomNames] = useState<Record<string, string>>({});
  useEffect(() => { void loadRoles().then((r) => setCustomNames(Object.fromEntries((r ?? []).filter((x) => !x.is_system).map((x) => [x.id, x.name]))), () => undefined); }, []);
  const [resetFor, setResetFor] = useState<StaffMember | null>(null);
  const [outletsFor, setOutletsFor] = useState<StaffMember | null>(null);
  const [creds, setCreds] = useState<StaffCredentials | null>(null);
  const canOutlets = hasPerm(me, "staff.manage_outlet_access", isOwner) || hasPerm(me, "users.manage", isOwner);
  const done = () => { void reload(); refresh(); };

  // You are the card above, not a second row in the list (the owner was listed twice).
  const staff = useMemo(() => [...(data ?? [])].filter((u) => u.id !== me.id).sort((a, b) => Number(b.is_active) - Number(a.is_active) || ROLES.indexOf(a.role) - ROLES.indexOf(b.role) || a.full_name.localeCompare(b.full_name)), [data, me.id]);

  async function toggle(u: StaffMember) {
    const off = u.is_active;
    if (off && !(await confirm({ title: t("confirmOffTitle", { name: u.full_name }), description: t("confirmOffDesc"), confirmLabel: t("deactivate"), tone: "danger" }))) return;
    try { await api.setStaffActive(u.id, !off); toast.success(off ? t("deactivated", { name: u.full_name }) : t("reactivated", { name: u.full_name })); done(); }
    catch (e) { toast.error(em(e, t("updateFail"))); }
  }

  return (
    <div className="space-y-5">
      <Card className="flex flex-wrap items-center gap-3">
        <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-primary-soft font-display font-extrabold text-primary-soft-fg">{initials(me.full_name)}</span>
        {/* Room for the name and email first: the badge and button wrap below rather than clipping them to "Asha Ra…". */}
        <div className="min-w-[min(100%,16rem)] flex-1">
          <p className="truncate font-semibold text-fg">{me.full_name} <span className="font-normal text-fg-subtle">{t("you")}</span></p>
          <p className="truncate text-sm text-fg-muted">{me.email ?? loginIdOf(me)}</p>
        </div>
        <Badge tone={ROLE_TONE[me.role]}>{tr(`${me.role}.label`)}</Badge>
        <Button variant="secondary" iconStart={<KeyRound />} onClick={() => setPwOpen(true)}>{t("changeMyPassword")}</Button>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-fg-muted">{anyAdmin ? t("introAdmin") : t("introBasic")}</p>
        {canCreate && <Button variant="primary" iconStart={<Plus />} onClick={() => setAddOpen(true)}>{t("addStaff")}</Button>}
      </div>

      {error && <Notice tone="danger" action={<Button variant="secondary" size="sm" onClick={() => void reload()}>{t("retry")}</Button>}>{error}</Notice>}

      {loading ? <div role="status" aria-label={t("loadingStaff")} className="space-y-2">{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-16 rounded-xl" />)}</div>
        : staff.length === 0 ? <Card><EmptyState icon={<UserCog />} title={t("emptyTitle")} hint={t("emptyHint")} /></Card>
        : (
          <Card padded={false}>
            <ul className="divide-y divide-border">
              {staff.map((u, n) => {
                const self = u.id === me.id;
                return (
                  <motion.li key={u.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(n, 8) * 0.025 }} className={cn("flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3", !u.is_active && "opacity-70")}>
                    <span className="grid size-10 shrink-0 place-items-center rounded-full bg-surface-2 text-sm font-bold text-fg-muted">{initials(u.full_name)}</span>
                    <div className="min-w-0 flex-1 basis-40">
                      <p className="truncate font-semibold text-fg">{u.full_name}{self && <span className="font-normal text-fg-subtle"> {t("you")}</span>}</p>
                      <p className="truncate text-xs text-fg-subtle">{t("addedOn", { email: u.email ?? loginIdOf(u), date: formatDate(u.created_at) })}</p>
                    </div>
                    <Badge tone={ROLE_TONE[u.role]}>{(u.custom_role_id && customNames[u.custom_role_id]) || tr(`${u.role}.label`)}</Badge>
                    {!u.is_active && <Badge tone="danger">{t("deactivatedBadge")}</Badge>}
                    {anyAdmin && (
                      <div className="flex flex-wrap gap-1.5">
                        {canRoles && <Button variant="secondary" size="sm" aria-label={t("changeRoleFor", { name: u.full_name })} iconStart={<ShieldCheck />} onClick={() => setRoleFor(u)}>{t("roleBtn")}</Button>}
                        {!self && canOutlets && (u.role === "waiter" || u.role === "cashier" || u.role === "kitchen" || !!u.custom_role_id) && <Button variant="secondary" size="sm" aria-label={`Outlets for ${u.full_name}`} iconStart={<Building2 />} onClick={() => setOutletsFor(u)}>Outlets</Button>}
                        {u.is_active && canManagePinOf(me, u) && <Button variant="secondary" size="sm" aria-label={`Counter PIN for ${u.full_name}`} iconStart={<Hash />} onClick={() => setPinFor(u)}>PIN</Button>}
                        {!self && canReset && <Button variant="secondary" size="sm" aria-label={t("resetPwFor", { name: u.full_name })} iconStart={<KeyRound />} onClick={() => setResetFor(u)}>{t("resetPwBtn")}</Button>}
                        {!self && canDeactivate && (u.is_active
                          ? <Button variant="danger-soft" size="sm" aria-label={t("deactivateFor", { name: u.full_name })} iconStart={<UserX />} onClick={() => void toggle(u)}>{t("deactivate")}</Button>
                          : <Button variant="secondary" size="sm" aria-label={t("reactivateFor", { name: u.full_name })} iconStart={<UserCheck />} onClick={() => void toggle(u)}>{t("reactivate")}</Button>)}
                      </div>
                    )}
                  </motion.li>
                );
              })}
            </ul>
          </Card>
        )}

      <details className="group rounded-2xl border border-border bg-surface p-4 shadow-card">
        <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold text-fg focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">{t("whatCanEach")}</summary>
        <dl className="mt-3 grid gap-2 sm:grid-cols-2">
          {ROLES.map((r) => <div key={r} className="rounded-xl bg-surface-2/60 p-3"><dt><Badge tone={ROLE_TONE[r]}>{tr(`${r}.label`)}</Badge></dt><dd className="mt-1 text-sm text-fg-muted">{tr(`${r}.blurb`)}</dd></div>)}
        </dl>
      </details>

      <AddStaffDialog open={addOpen} onClose={() => setAddOpen(false)} onDone={(c) => { done(); if (c) setCreds(c); }}
        roles={me.role === "owner" ? ROLES : ROLES.filter((r) => r !== "owner")}
        rolePicker={(value, onChange, allowed) => <RolePills value={value} onChange={onChange} allowed={allowed} />} />
      <RoleDialog user={roleFor} onClose={() => setRoleFor(null)} onDone={done} />
      <ResetPasswordDialog user={resetFor} onClose={() => setResetFor(null)} onTemporary={setCreds} />
      <OutletAccessDialog user={outletsFor} onClose={() => setOutletsFor(null)} />
      <StaffPinDialog user={pinFor} onClose={() => setPinFor(null)} />
      <CredentialsDialog creds={creds} onClose={() => setCreds(null)} /> 
      <PasswordDialog open={pwOpen} onClose={() => setPwOpen(false)} />
    </div>
  );
}

/* ------------------------------------------------------------------ role */
/** Value of the picker: a built-in role ("sys:cashier") or a custom role ("custom:<id>"). */
function RoleDialog({ user, onClose, onDone }: { user: StaffMember | null; onClose: () => void; onDone: () => void }) {
  const t = useMsg(STAFF_MSG);
  const tr = useMsg(ROLE_INFO_MSG);
  const [pick, setPick] = useState("sys:cashier");
  const [custom, setCustom] = useState<RoleDef[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [last, setLast] = useState<StaffMember | null>(null);
  useEffect(() => {
    if (!user) return;
    let off = false;
    void Promise.resolve().then(() => { setPick(user.custom_role_id ? `custom:${user.custom_role_id}` : `sys:${user.role}`); setErr(null); setLast(user); });
    // Custom roles are optional: a server without the API simply offers the five built-in roles.
    void loadRoles().then((r) => { if (!off) setCustom((r ?? []).filter((x) => !x.is_system)); }, () => { if (!off) setCustom([]); });
    return () => { off = true; };
  }, [user]);
  const shown = user ?? last;
  const current = user ? (user.custom_role_id ? `custom:${user.custom_role_id}` : `sys:${user.role}`) : pick;
  async function save() {
    if (!user) return;
    setBusy(true); setErr(null);
    try {
      if (pick.startsWith("custom:")) {
        const r = custom.find((c) => `custom:${c.id}` === pick);
        await api.setUserRole(user.id, { role_id: pick.slice(7) });
        toast.success(r ? t("nowRole", { name: user.full_name, role: r.name }) : t("nowCustom", { name: user.full_name }));
      } else {
        const role = pick.slice(4) as Role;
        if (user.custom_role_id) await api.setUserRole(user.id, { role }); else await api.updateStaff(user.id, { role });
        toast.success(t("nowRole", { name: user.full_name, role: tr(`${role}.label`).toLowerCase() }));
      }
      onClose(); onDone();
    } catch (e) { setErr(isUnsupported(e) ? t("noCustomYet") : em(e, t("roleFail"))); } finally { setBusy(false); }
  }
  return (
    <Dialog open={!!user} onOpenChange={(o) => { if (!o) onClose(); }} title={shown ? t("roleFor", { name: shown.full_name }) : t("changeRole")} description={t("roleDesc")}
      footer={<><Button variant="secondary" onClick={onClose}>{t("cancel")}</Button><Button variant="primary" loading={busy} disabled={!user || pick === current} onClick={() => void save()}>{t("saveRole")}</Button></>}>
      <div className="space-y-3 py-2">
        {err && <Notice tone="danger">{err}</Notice>}
        <RolePills value={pick.startsWith("sys:") ? (pick.slice(4) as Role) : null} onChange={(r) => setPick(`sys:${r}`)} allowed={ROLES} />
        {custom.length > 0 && (
          <fieldset className="space-y-2" data-testid="custom-role-options">
            <legend className="mb-1.5 text-sm font-semibold text-fg">{t("customRoles")}</legend>
            {custom.map((r) => (
              <label key={r.id} className={cn("flex min-h-14 cursor-pointer items-start gap-3 rounded-xl border p-3 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring", pick === `custom:${r.id}` ? "border-primary bg-primary-soft/60" : "border-border bg-surface hover:bg-surface-2")}>
                <input type="radio" name="role" value={`custom:${r.id}`} checked={pick === `custom:${r.id}`} onChange={() => setPick(`custom:${r.id}`)} className="mt-1 size-4 accent-[var(--primary)]" />
                <span><span className="block text-sm font-semibold text-fg">{r.name}</span><span className="block text-xs text-fg-muted">{t("permCount", { n: r.permissions.length })}</span></span>
              </label>
            ))}
          </fieldset>
        )}
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ reset someone else's password */
function ResetPasswordDialog({ user, onClose, onTemporary }: { user: StaffMember | null; onClose: () => void; onTemporary: (c: StaffCredentials) => void }) {
  const t = useMsg(STAFF_MSG);
  const [pw, setPw] = useState("");
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [last, setLast] = useState<StaffMember | null>(null);
  useEffect(() => { if (user) void Promise.resolve().then(() => { setPw(generatePassword()); setCopied(false); setErr(null); setLast(user); }); }, [user]);
  const shown = user ?? last;

  async function copy() {
    try { await navigator.clipboard.writeText(pw); setCopied(true); toast.success(t("copied")); setTimeout(() => setCopied(false), 2000); }
    catch { toast.error(t("copyFail")); }
  }
  async function save() {
    if (!user) return;
    if (pw.length < 10) { setErr(t("errMin10Dot")); return; }
    setBusy(true); setErr(null);
    try { await api.resetUserPassword(user.id, pw); toast.success(t("resetDone", { name: user.full_name })); onClose(); }
    catch (e) { setErr(em(e, t("resetFail"))); } finally { setBusy(false); }
  }
  async function oneTime() {
    if (!user) return;
    setBusy(true); setErr(null);
    try {
      const r = await api.temporaryPassword(user.id);
      onClose();
      onTemporary({ full_name: user.full_name, restaurant_code: r.restaurant_code, login_identifier: r.login_identifier, temporary_password: r.temporary_password });
    } catch (e) { setErr(em(e, t("resetFail"))); } finally { setBusy(false); }
  }
  return (
    <Dialog open={!!user} onOpenChange={(o) => { if (!o) onClose(); }} title={shown ? t("resetTitle", { name: shown.full_name }) : t("resetTitleBare")}
      description={t("resetDesc")}
      footer={<><Button variant="secondary" onClick={onClose}>{t("cancel")}</Button><Button variant="secondary" loading={busy} disabled={!user} onClick={() => void oneTime()}>One-time password</Button><Button variant="primary" loading={busy} disabled={!user} onClick={() => void save()}>{t("setNewPw")}</Button></>}>
      <div className="space-y-3 py-2">
        {err && <Notice tone="danger">{err}</Notice>}
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1"><Input label={t("newPassword")} autoComplete="off" spellCheck={false} value={pw} onChange={(e) => { setPw(e.target.value); setCopied(false); }} hint={t("newPasswordHint")} /></div>
          <div className="mt-[1.7rem] flex gap-1">
            <Button variant="secondary" aria-label={t("generatePw")} title={t("generatePw")} className="size-11 p-0" onClick={() => { setPw(generatePassword()); setCopied(false); }}><RefreshCw /></Button>
            <Button variant="secondary" aria-label={t("copyPw")} title={t("copyPw")} className="size-11 p-0" onClick={() => void copy()}>{copied ? <Check /> : <Copy />}</Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ own password */
type PwForm = z.infer<typeof pwSchema>;

function PasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const signOut = useSignOut();
  const t = useMsg(STAFF_MSG);
  const ta = useMsg(AUTH_MSG);
  const { register, handleSubmit, reset, setError, formState: { errors, isSubmitting } } = useForm<PwForm>({ resolver: zodResolver(pwSchema), defaultValues: { current: "", next: "", again: "" } });
  useEffect(() => { if (open) reset({ current: "", next: "", again: "" }); }, [open, reset]);
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }} title={t("ownTitle")} description={t("ownDesc")}
      footer={<><Button variant="secondary" onClick={onClose}>{t("cancel")}</Button><Button variant="primary" type="submit" form="pw-form" loading={isSubmitting}>{t("changePw")}</Button></>}>
      <form id="pw-form" noValidate className="space-y-4 py-2" onSubmit={handleSubmit(async (v) => {
        try { await api.changePassword(v.current, v.next); toast.success(t("pwChanged")); onClose(); await signOut(); }
        catch (e) { setError("current", { message: em(e, t("pwChangeFail")) }); }
      })}>
        <Input label={t("currentPassword")} type="password" autoComplete="current-password" error={fieldError(ta, errors.current?.message)} {...register("current")} />
        <Input label={t("newPassword")} type="password" autoComplete="new-password" error={fieldError(ta, errors.next?.message)} {...register("next")} />
        <Input label={t("newPasswordAgain")} type="password" autoComplete="new-password" error={fieldError(ta, errors.again?.message)} {...register("again")} />
      </form>
    </Dialog>
  );
}
