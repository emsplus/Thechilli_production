"use client";

import { useEffect, useMemo, useState } from "react";
import { Copy, Pencil, Plus, ShieldCheck, Trash2 } from "lucide-react";
import "@chilli/ui/data.css";
import { DataTable, type DataColumn } from "@chilli/ui/data";
import { Badge, Button, Checkbox, Dialog, Input, Notice } from "@chilli/ui";
import { Card, toast, useConfirm } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { loadRoles, loadCatalogue, isUnsupported, type CatalogueGroup } from "@/lib/roles";
import { useLoader } from "@/lib/useLoader";
import type { RoleDef } from "@/lib/types";
import { useMsg } from "@/lib/i18n";
import { ROLE_INFO_MSG, ROLES_MSG } from "./staff-messages";

const em = (e: unknown, fb: string) => (e instanceof ApiError ? e.message : fb);

/**
 * Custom roles (pos-service docs/ROLES_API.md: GET/POST /roles, PATCH/DELETE /roles/{id}, POST /roles/{id}/clone, GET /permissions).
 * A server without them (404 / 405 / 501) gets an explanation and the built-in roles, never an error screen.
 */
export function RolesPanel({ canManage }: { canManage: boolean }) {
  const confirm = useConfirm();
  const t = useMsg(ROLES_MSG);
  const tr = useMsg(ROLE_INFO_MSG);
  const { data, error, loading, reload } = useLoader(loadRoles);
  const [editing, setEditing] = useState<RoleDef | "new" | null>(null);
  const custom = useMemo(() => (data ?? []).filter((r) => !r.is_system), [data]);

  async function remove(r: RoleDef) {
    const description = r.user_count ? t(r.user_count === 1 ? "confirmDescOne" : "confirmDescMany", { n: r.user_count }) : t("confirmDesc");
    if (!(await confirm({ title: t("confirmTitle", { name: r.name }), description, confirmLabel: t("deleteRole"), tone: "danger" }))) return;
    try { await api.deleteRole(r.id); toast.success(t("deleted", { name: r.name })); await reload(); }
    catch (e) { toast.error(isUnsupported(e) ? t("deleteUnsupported") : e instanceof ApiError && e.status === 409 ? t("deleteInUse") : em(e, t("deleteFail"))); }
  }
  async function duplicate(r: RoleDef) {
    try { await api.cloneRole(r.id, [`${r.name} copy`]); toast.success(t("duplicated", { name: r.name })); await reload(); }
    catch (e) { toast.error(e instanceof ApiError && e.status === 409 ? t("duplicateExists") : em(e, t("duplicateFail"))); }
  }

  const columns: DataColumn<RoleDef>[] = [
    { key: "name", header: t("colRole"), sortValue: (r) => r.name, render: (r) => <span><span className="font-semibold">{r.name}</span>{r.permission_snapshot?.outlets ? <span className="block text-xs opacity-70">{r.permission_snapshot.outlets.access_all ? t("allOutlets") : t("grantedOutlets")}</span> : null}</span> },
    { key: "perms", header: t("colPerms"), align: "end", sortValue: (r) => r.permissions.length, render: (r) => r.permissions.length },
    { key: "people", header: t("colPeople"), align: "end", sortValue: (r) => r.user_count ?? 0, render: (r) => r.user_count ?? "-" },
    { key: "actions", header: "", render: (r) => canManage ? (
      <span className="flex gap-1.5">
        <Button size="sm" variant="secondary" iconStart={<Pencil />} aria-label={t("editRole", { name: r.name })} onClick={() => setEditing(r)}>{t("edit")}</Button>
        <Button size="sm" variant="secondary" iconStart={<Copy />} aria-label={t("duplicateRole", { name: r.name })} onClick={() => void duplicate(r)}>{t("duplicate")}</Button>
        <Button size="sm" variant="danger-soft" iconStart={<Trash2 />} aria-label={t("deleteRoleAria", { name: r.name })} onClick={() => void remove(r)}>{t("delete")}</Button>
      </span>
    ) : null },
  ];

  return (
    <div className="space-y-4" data-testid="roles-panel">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-fg-muted">{t("intro")}</p>
        {canManage && data !== null && <Button variant="primary" iconStart={<Plus />} onClick={() => setEditing("new")}>{t("newRole")}</Button>}
      </div>

      {error && <Notice tone="danger" action={<Button variant="secondary" size="sm" onClick={() => void reload()}>{t("retry")}</Button>}>{error}</Notice>}

      {!loading && !error && data === null && (
        <Notice tone="info" title={t("unavailableTitle")}>
          {t("unavailableBody")}
        </Notice>
      )}

      {data !== null && (
        <DataTable<RoleDef> caption={t("tableCaption")} columns={columns} rows={custom} getKey={(r) => r.id}
          status={loading ? "loading" : error ? "error" : "ready"} onRetry={() => void reload()} loadingRows={3}
          empty={<div className="py-4 text-center text-sm text-fg-muted"><ShieldCheck aria-hidden className="mx-auto mb-2 size-6" />{canManage ? t("emptyManage") : t("empty")}</div>} />
      )}

      <Card>
        <h3 className="mb-2 text-sm font-semibold text-fg">{t("builtIn")}</h3>
        <dl className="grid gap-2 sm:grid-cols-2">
          {["owner", "manager", "cashier", "waiter", "kitchen"].map((k) => <div key={k} className="rounded-xl bg-surface-2/60 p-3"><dt><Badge tone="neutral">{tr(`${k}.label`)}</Badge></dt><dd className="mt-1 text-sm text-fg-muted">{tr(`${k}.blurb`)}</dd></div>)}
        </dl>
      </Card>

      <RoleEditor target={editing} onClose={() => setEditing(null)} onDone={() => void reload()} />
    </div>
  );
}

function RoleEditor({ target, onClose, onDone }: { target: RoleDef | "new" | null; onClose: () => void; onDone: () => void }) {
  const t = useMsg(ROLES_MSG);
  const [name, setName] = useState("");
  const [catalogue, setCatalogue] = useState<CatalogueGroup[]>([]);
  const [access, setAccess] = useState<string | null>(null);
  const [perms, setPerms] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const isNew = target === "new";
  useEffect(() => {
    if (!target) return;
    void Promise.resolve().then(() => {
      setName(target === "new" ? "" : target.name); setAccess(target === "new" ? null : target.permission_snapshot?.outlets?.effect ?? null);
      setPerms(new Set(target === "new" ? [] : target.permissions)); setErr(null);
    });
  }, [target]);
  useEffect(() => { if (target) void loadCatalogue().then(setCatalogue); }, [target]);
  const known = new Set(catalogue.flatMap((g) => g.perms.map((p) => p.code)));
  const unknown = target && target !== "new" ? target.permissions.filter((p) => !known.has(p)) : [];
  const toggle = (code: string, on: boolean) => setPerms((p) => { const n = new Set(p); if (on) n.add(code); else n.delete(code); return n; });

  async function save() {
    if (!target) return;
    const body = { name: name.trim(), permissions: [...perms].sort() };
    if (!body.name) { setErr(t("nameRequired")); return; }
    if (body.permissions.length === 0) { setErr(t("permRequired")); return; }
    setBusy(true); setErr(null);
    try {
      if (isNew) await api.createRole(body); else await api.updateRole((target as RoleDef).id, body);
      toast.success(isNew ? t("created", { name: body.name }) : t("saved", { name: body.name })); onClose(); onDone();
    } catch (e) {
      setErr(isUnsupported(e) ? t("saveUnsupported") : e instanceof ApiError && e.status === 409 ? t("nameExists") : e instanceof ApiError && e.status === 403 ? t("forbidden") : em(e, t("saveFail")));
    } finally { setBusy(false); }
  }

  return (
    <Dialog open={!!target} onOpenChange={(o) => { if (!o) onClose(); }} title={isNew ? t("editorNew") : t("editorEdit")} description={t("editorDesc")}
      footer={<><Button variant="secondary" onClick={onClose}>{t("cancel")}</Button><Button variant="primary" loading={busy} onClick={() => void save()}>{isNew ? t("createRole") : t("saveRole")}</Button></>}>
      <div className="space-y-4 py-2">
        {err && <Notice tone="danger">{err}</Notice>}
        <Input label={t("roleName")} value={name} maxLength={60} onChange={(e) => setName(e.target.value)} autoFocus />
        {access && <Notice tone="info">{access}</Notice>}
        {catalogue.map((g) => {
          const grantable = g.perms.filter((p) => p.grantable);
          const all = grantable.length > 0 && grantable.every((p) => perms.has(p.code));
          return (
            <fieldset key={g.id} className="rounded-xl border border-border p-3">
              <legend className="px-1 text-sm font-semibold text-fg">{g.label}</legend>
              <Checkbox label={t("allOf", { group: g.label.toLowerCase() })} checked={all} onChange={(e) => setPerms((p) => { const n = new Set(p); grantable.forEach((x) => (e.target.checked ? n.add(x.code) : n.delete(x.code))); return n; })} />
              <div className="grid gap-x-4 sm:grid-cols-2">
                {g.perms.map((p) => <Checkbox key={p.code} label={p.label} hint={p.note ?? (p.grantable ? p.code : t("notHeld"))} disabled={!p.grantable} checked={perms.has(p.code)} onChange={(e) => toggle(p.code, e.target.checked)} />)}
              </div>
            </fieldset>
          );
        })}
        {unknown.length > 0 && (
          <fieldset className="rounded-xl border border-border p-3">
            <legend className="px-1 text-sm font-semibold text-fg">{t("other")}</legend>
            {unknown.map((c) => <Checkbox key={c} label={c} checked={perms.has(c)} onChange={(e) => toggle(c, e.target.checked)} />)}
          </fieldset>
        )}
      </div>
    </Dialog>
  );
}
