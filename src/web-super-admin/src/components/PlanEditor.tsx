"use client";
import { useState, type FormEvent } from "react";
import { Button, Dialog, Input } from "@chilli/ui";
import { api } from "@/lib/api";
import type { Feature, Plan, PlanFeature } from "@/lib/api/types";
import { useAction } from "@/lib/useResource";
import { InlineError } from "@/components/ui";

/** "1499" / "1,499.50" -> integer paise, or null when not a valid amount with at most 2 decimals. */
export function rupeesToPaise(v: string): number | null {
  const m = /^\d{1,9}(\.\d{1,2})?$/.exec(v.trim().replace(/,/g, ""));
  if (!m) return null;
  const [w, f = ""] = v.trim().replace(/,/g, "").split(".");
  return Number(w) * 100 + Number((f + "00").slice(0, 2));
}
export const paiseToRupees = (p: number) => (p % 100 === 0 ? String(p / 100) : (p / 100).toFixed(2));

type Row = { enabled: boolean; limit: string };
const toRows = (features: Feature[], plan?: Plan): Record<string, Row> =>
  Object.fromEntries(features.filter((f) => f.is_active).map((f) => { const pf = plan?.features.find((x) => x.feature_code === f.code); return [f.code, { enabled: !!pf?.enabled, limit: pf?.limit_value == null ? "" : String(pf.limit_value) }]; }));

/** Create (no `plan`) or edit a plan. Edits are versioned: the server rejects a stale `expected_version`. */
export function PlanEditor({ plan, features, onClose, onDone }: { plan?: Plan; features: Feature[]; onClose: () => void; onDone: (p: Plan) => void }) {
  const [code, setCode] = useState("");
  const [name, setName] = useState(plan?.name ?? "");
  const [desc, setDesc] = useState(plan?.description ?? "");
  const [price, setPrice] = useState(plan ? paiseToRupees(plan.price_paise) : "");
  const [period, setPeriod] = useState<"month" | "year">(plan?.billing_period ?? "month");
  const [note, setNote] = useState("");
  const [rows, setRows] = useState(() => toRows(features, plan));
  const [touched, setTouched] = useState(false);
  const paise = rupeesToPaise(price);
  const limitBad = (f: Feature) => { const r = rows[f.code]; return f.kind === "limit" && r.enabled && r.limit !== "" && !/^\d{1,9}$/.test(r.limit); };
  const bad = { code: !plan && !/^[a-z][a-z0-9_.]{1,63}$/.test(code), name: name.trim().length < 2, price: paise === null, limits: features.some((f) => f.is_active && limitBad(f)) };
  const build = (): PlanFeature[] => features.filter((f) => f.is_active && rows[f.code].enabled).map((f) => ({ feature_code: f.code, enabled: true, limit_value: f.kind === "limit" && rows[f.code].limit !== "" ? Number(rows[f.code].limit) : null }));
  const { run, busy, error } = useAction(async () => {
    const saved = plan
      ? await api.catalog.editPlan(plan.code, { expected_version: plan.version, name: name.trim(), description: desc.trim() || null, price_paise: paise!, features: build(), note: note.trim() || undefined })
      : await api.catalog.createPlan({ code, name: name.trim(), description: desc.trim() || null, price_paise: paise!, billing_period: period, features: build() });
    onDone(saved);
  });
  const submit = (e: FormEvent) => { e.preventDefault(); setTouched(true); if (!Object.values(bad).some(Boolean)) void run(); };
  const live = plan?.live_subscriptions ?? 0;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={plan ? `Edit ${plan.name}` : "New plan"}
      description={plan ? `Version ${plan.version}. ${live} live ${live === 1 ? "subscription follows" : "subscriptions follow"} feature and limit changes at once; a new price applies to invoices created from now on.` : "Prices exclude GST. The code cannot be changed later."}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="plan-form" loading={busy}>{plan ? "Save new version" : "Create plan"}</Button></>}>
      <form id="plan-form" className="hq-stack" onSubmit={submit} noValidate>
        {!plan ? <Input label="Code" value={code} onChange={(e) => setCode(e.target.value)} hint="Lowercase letters, digits, dot or underscore. Example: growth" error={touched && bad.code ? "Use a lowercase code of 2-64 characters starting with a letter." : undefined} /> : null}
        <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} error={touched && bad.name ? "Enter a name." : undefined} />
        <Input label="Description" value={desc} onChange={(e) => setDesc(e.target.value)} />
        <Input label={`Price per ${period} (rupees, excl. GST)`} inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} error={touched && bad.price ? "Enter an amount like 1499 or 1499.50." : undefined} />
        {!plan ? <label className="ch-field"><span className="ch-label">Billing period</span><select className="ch-input" value={period} onChange={(e) => setPeriod(e.target.value as "month" | "year")}><option value="month">Monthly</option><option value="year">Yearly</option></select></label> : null}
        <fieldset className="hq-stack" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="ch-label">Features and limits</legend>
          {features.filter((f) => f.is_active).map((f) => (
            <div key={f.code} className="hq-row">
              <label className="hq-check" style={{ minWidth: "14rem" }}><input type="checkbox" checked={rows[f.code].enabled} onChange={(e) => setRows({ ...rows, [f.code]: { ...rows[f.code], enabled: e.target.checked } })} /> {f.name}</label>
              {f.kind === "limit" ? <Input label={`${f.name} (blank = unlimited)`} inputMode="numeric" disabled={!rows[f.code].enabled} value={rows[f.code].limit} onChange={(e) => setRows({ ...rows, [f.code]: { ...rows[f.code], limit: e.target.value } })} error={touched && limitBad(f) ? "Whole number or blank." : undefined} /> : null}
            </div>
          ))}
        </fieldset>
        {plan ? <Input label="Change note (optional)" value={note} onChange={(e) => setNote(e.target.value)} hint="Kept in the plan's version history and the audit log." /> : null}
        <InlineError error={error} />
        {error?.code === "version_conflict" ? <p className="hq-sub">Someone else changed this plan. Close this dialog, reload and re-apply your edit.</p> : null}
      </form>
    </Dialog>
  );
}
