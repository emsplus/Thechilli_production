"use client";
import { Suspense, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Badge, Button, Dialog, Input, Select, Table, useToast } from "@chilli/ui";
import { api, ApiError } from "@/lib/api";
import type { EntitlementValue, Feature } from "@/lib/api/types";
import { fmtDateTime } from "@/lib/format";
import { useTenants } from "@/lib/hooks";
import { useCan } from "@/lib/session";
import { useAction, useResource } from "@/lib/useResource";
import { EmptyState } from "@chilli/ui";
import { InlineError, LoadingRows, Notice, PageHeader, ReasonDialog, ResourceView, StatusBadge, TextArea } from "@/components/ui";

export default function EntitlementsPage() {
  return <Suspense fallback={<LoadingRows />}><Inner /></Suspense>;
}

function Inner() {
  const router = useRouter();
  const params = useSearchParams();
  const ref = params.get("tenant") ?? "";
  const { tenants, loading: tl } = useTenants();
  return (
    <>
      <PageHeader title="Entitlements" subtitle="What a business may use right now: its plan plus any time-boxed overrides." />
      <div className="hq-filters">
        <Select label="Business" value={ref} onChange={(e) => router.replace(e.target.value ? `/platform/entitlements?tenant=${encodeURIComponent(e.target.value)}` : "/platform/entitlements")} disabled={tl}>
          <option value="">Choose a business…</option>{tenants.map((t) => <option key={t.id} value={t.slug}>{t.display_name}</option>)}
        </Select>
      </div>
      {ref ? <Detail key={ref} tenantRef={ref} /> : <EmptyState title="Choose a business" description="Pick one above to see and adjust what it can use." />}
    </>
  );
}

function Detail({ tenantRef }: { tenantRef: string }) {
  const can = useCan();
  const toast = useToast();
  const res = useResource(async () => {
    const [e, f, h] = await Promise.all([api.catalog.entitlements(tenantRef), api.catalog.features(), api.catalog.entitlementHistory(tenantRef, 20)]);
    return { e, features: f.items, history: h.items };
  }, tenantRef);
  const [edit, setEdit] = useState<Feature | null>(null);
  const [removing, setRemoving] = useState<Feature | null>(null);
  const override = can("entitlements.override");
  return (
    <ResourceView res={res} isEmpty={() => false} empty={{ title: "" }}>
      {({ e, features, history }) => (
        <>
          <p className="hq-sub">Plan: <strong>{e.plan_code ?? "none"}</strong> · Business {e.tenant_status} · Subscription {e.subscription_status ?? e.subscription_reason}</p>
          {e.tenant_status !== "active" ? <Notice tone="warning">This business is {e.tenant_status}, so every feature is off regardless of plan.</Notice> : null}
          <Table<Feature> caption="Effective features" getKey={(f) => f.code} rows={features.filter((f) => f.is_active)} columns={[
            { key: "f", header: "Feature", render: (f) => <>{f.name} <span className="hq-mono hq-muted">{f.code}</span></> },
            { key: "v", header: "Value", render: (f) => { const v: EntitlementValue | undefined = e.features[f.code]; return v?.enabled ? <Badge tone="success">{f.kind === "limit" ? `Limit ${v.limit ?? "none"}` : "On"}</Badge> : <Badge>Off</Badge>; } },
            { key: "s", header: "Source", render: (f) => e.features[f.code]?.source ?? "–" },
            { key: "a", header: "Override", render: (f) => (override ? <div className="hq-row"><Button size="sm" onClick={() => setEdit(f)}>{e.features[f.code]?.source === "override" ? "Change" : "Set"}</Button>{e.features[f.code]?.source === "override" ? <Button size="sm" variant="danger-soft" onClick={() => setRemoving(f)}>Remove</Button> : null}</div> : null) },
          ]} />
          <h2 className="hq-h2">Recent changes</h2>
          <Table caption="Entitlement history" getKey={(h) => String(h.id)} rows={history} empty={<p className="hq-muted">No changes recorded.</p>} columns={[
            { key: "d", header: "When", render: (h) => fmtDateTime(h.created_at ?? h.at) }, { key: "f", header: "Feature", render: (h) => h.feature_code },
            { key: "c", header: "Change", render: (h) => `${h.before?.enabled ? "on" : "off"} to ${h.after?.enabled ? "on" : "off"}` }, { key: "t", header: "Why", render: (h) => <><StatusBadge value={h.trigger} /> {h.reason ?? ""}</> }, { key: "a", header: "By", render: (h) => h.actor },
          ]} />
          {edit ? <OverrideDialog f={edit} tenantRef={tenantRef} onClose={() => setEdit(null)} onDone={() => { setEdit(null); toast.show("Override saved", "success"); res.reload(); }} /> : null}
          {removing ? <ReasonDialog open onOpenChange={(o) => !o && setRemoving(null)} title="Remove override" description={`${removing.name} goes back to what the plan says.`} confirmLabel="Remove override" askReason={false}
            onConfirm={async (): Promise<ApiError | undefined> => { try { await api.catalog.removeOverride(tenantRef, removing.code); toast.show("Override removed", "success"); res.reload(); } catch (err) { return err as ApiError; } }} /> : null}
        </>
      )}
    </ResourceView>
  );
}

function OverrideDialog({ f, tenantRef, onClose, onDone }: { f: Feature; tenantRef: string; onClose: () => void; onDone: () => void }) {
  const [enabled, setEnabled] = useState("true");
  const [limit, setLimit] = useState("");
  const [days, setDays] = useState("30");
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);
  const d = Number(days);
  const bad = { reason: reason.trim().length < 3, days: days !== "" && !(d >= 1 && d <= 365), limit: limit !== "" && !(Number(limit) >= 0) };
  const { run, busy, error } = useAction(async () => {
    await api.catalog.setOverride(tenantRef, f.code, { enabled: enabled === "true", limit_value: f.kind === "limit" && limit !== "" ? Number(limit) : null, reason: reason.trim(), expires_at: days ? new Date(Date.now() + d * 864e5).toISOString() : null });
    onDone();
  });
  const submit = (e: FormEvent) => { e.preventDefault(); setTouched(true); if (!Object.values(bad).some(Boolean)) void run(); };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`Override: ${f.name}`} description="Applies to this business only and is recorded with your reason."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="ovr" loading={busy}>Save override</Button></>}>
      <form id="ovr" className="hq-stack" onSubmit={submit} noValidate>
        <Select label="Feature is" value={enabled} onChange={(e) => setEnabled(e.target.value)}><option value="true">On</option><option value="false">Off</option></Select>
        {f.kind === "limit" ? <Input label={`Limit${f.unit ? ` (${f.unit})` : ""}`} type="number" min={0} value={limit} onChange={(e) => setLimit(e.target.value)} error={touched && bad.limit ? "Enter 0 or more." : undefined} /> : null}
        <Input label="Expires after (days)" type="number" min={1} max={365} value={days} onChange={(e) => setDays(e.target.value)} hint="Leave empty for no expiry." error={touched && bad.days ? "Enter 1 to 365 days." : undefined} />
        <TextArea label="Reason" value={reason} onChange={setReason} error={touched && bad.reason ? "Give a reason." : undefined} />
        <InlineError error={error} />
      </form>
    </Dialog>
  );
}
