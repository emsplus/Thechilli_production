"use client";
import Link from "next/link";
import { Badge, Card, Money } from "@chilli/ui";
import { api } from "@/lib/api";
import { fmtDateTime, fmtNumber, timeAgo, titleCase } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useResource } from "@/lib/useResource";
import { LoadingRows, PageHeader, StatusBadge, InlineError } from "@/components/ui";
import type { TenantStatus } from "@/lib/api/types";

const STATUSES: TenantStatus[] = ["active", "pending", "suspended"];

/** Platform facts only: counts and statuses. Nothing about what any business sells or who it serves. */
export default function OverviewPage() {
  const { perms } = useSession();
  const can = (p: Parameters<typeof perms.has>[0]) => perms.has(p);
  const tenants = useResource(async () => {
    const [all, ...rest] = await Promise.all([api.tenants.list({ limit: 1 }), ...STATUSES.map((s) => api.tenants.list({ limit: 1, status: s }))]);
    return { total: all.total, by: Object.fromEntries(STATUSES.map((s, i) => [s, rest[i].total])) as Record<TenantStatus, number> };
  }, "ov-tenants");
  const onboarding = useResource(async () => (await api.onboarding.list({ limit: 1, status: "received" })).total, "ov-onb", can("onboarding.read"));
  const subs = useResource(async () => (await api.catalog.subscriptions()).items, "ov-subs", can("subscriptions.read"));
  const invoices = useResource(async () => (await api.billing.invoices({ limit: 200, status: "issued" })).items, "ov-inv", can("invoices.read"));
  const health = useResource(() => api.system.health(), "ov-health", can("system.read"));
  const latestApps = useResource(async () => (await api.onboarding.list({ limit: 50 })).items.slice().sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 5), "ov-apps", can("onboarding.read"));
  const activity = useResource(async () => (await api.logs.audit({ limit: 50 })).items.slice().sort((a, b) => b.at.localeCompare(a.at)).slice(0, 6), "ov-audit", can("audit.read"));

  const live = subs.data?.filter((s) => ["trialing", "active", "past_due"].includes(s.status)) ?? [];
  const pastDue = live.filter((s) => s.status === "past_due").length;
  const outstanding = invoices.data?.reduce((n, i) => n + i.total_paise, 0) ?? 0;

  return (
    <>
      <PageHeader title="Overview" subtitle="Platform health at a glance." />
      <div className="hq-grid" aria-live="polite">
        <Kpi href="/businesses" label="Businesses" loading={tenants.loading} value={tenants.data ? fmtNumber(tenants.data.total) : ""} error={tenants.error?.message} extra={tenants.data ? STATUSES.map((s) => `${tenants.data!.by[s]} ${s}`).join(" · ") : undefined} />
        {can("onboarding.read") ? <Kpi href="/onboarding" label="New applications" loading={onboarding.loading} value={onboarding.data !== undefined ? fmtNumber(onboarding.data) : ""} error={onboarding.error?.message} extra="waiting for review" /> : null}
        {can("subscriptions.read") ? <Kpi href="/billing/subscriptions" label="Live subscriptions" loading={subs.loading} value={subs.data ? fmtNumber(live.length) : ""} error={subs.error?.message} extra={subs.data ? `${pastDue} past due` : undefined} /> : null}
        {can("invoices.read") ? <Kpi href="/billing/invoices" label="Awaiting payment" loading={invoices.loading} value={invoices.data ? <Money value={outstanding} compact /> : ""} error={invoices.error?.message} extra={invoices.data ? `${invoices.data.length} issued invoices (incl. GST)` : undefined} /> : null}
        {can("system.read") ? <Kpi href="/security/health" label="System" loading={health.loading} value={health.data ? <StatusBadge value={health.data.status} /> : ""} error={health.error?.message} extra={health.data ? `${health.data.failed_onboardings} failed onboardings · checked ${timeAgo(health.data.checked_at)}` : undefined} /> : null}
      </div>
      {tenants.loading && !tenants.data ? <LoadingRows rows={1} /> : null}
      <InlineError error={tenants.error} />
      {health.data && health.data.jobs.some((j) => !j.healthy) ? (
        <Card as="section" style={{ marginTop: 16 }}>
          <h2 className="hq-card-title">Needs attention</h2>
          <ul>
            {health.data.jobs.filter((j) => !j.healthy).map((j) => (
              <li key={`${j.service}/${j.job_name}`}><Badge tone="danger">{j.stale ? "Stale" : "Error"}</Badge> {j.service} / {j.job_name} · last seen {timeAgo(j.last_seen_at)}</li>
            ))}
          </ul>
          <Link className="hq-link" href="/security/health">Open system health</Link>
        </Card>
      ) : null}
      {can("onboarding.read") || can("audit.read") ? (
        <div className="hq-grid-2" style={{ marginTop: 16 }}>
          {can("onboarding.read") ? (
            <Card as="section" aria-labelledby="ov-apps-h">
              <h2 className="hq-card-title" id="ov-apps-h">Latest applications</h2>
              {latestApps.data && latestApps.data.length === 0 ? <p className="hq-muted">No applications yet.</p> : null}
              <ul className="hq-feed">
                {latestApps.data?.map((a) => (
                  <li key={a.id}>
                    <span className="hq-feed__main"><strong>{a.business_name}</strong><small>{titleCase(a.source)} · {a.contact_name}</small></span>
                    <span className="hq-feed__side"><StatusBadge value={a.status} /><small title={fmtDateTime(a.created_at)}>{timeAgo(a.created_at)}</small></span>
                  </li>
                ))}
              </ul>
              {latestApps.loading && !latestApps.data ? <LoadingRows rows={3} /> : null}
              <InlineError error={latestApps.error} />
              <Link className="hq-link" href="/onboarding">All applications</Link>
            </Card>
          ) : null}
          {can("audit.read") ? (
            <Card as="section" aria-labelledby="ov-act-h">
              <h2 className="hq-card-title" id="ov-act-h">Recent staff activity</h2>
              {activity.data && activity.data.length === 0 ? <p className="hq-muted">Nothing recorded yet.</p> : null}
              <ul className="hq-feed">
                {activity.data?.map((e) => (
                  <li key={e.id}>
                    <span className="hq-feed__main"><strong>{titleCase(e.action)}</strong><small>{e.actor_label ?? e.actor_type}</small></span>
                    <span className="hq-feed__side"><small title={fmtDateTime(e.at)}>{timeAgo(e.at)}</small></span>
                  </li>
                ))}
              </ul>
              {activity.loading && !activity.data ? <LoadingRows rows={3} /> : null}
              <InlineError error={activity.error} />
              <Link className="hq-link" href="/security/audit">Open audit log</Link>
            </Card>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function Kpi({ href, label, value, extra, loading, error }: { href: string; label: string; value: React.ReactNode; extra?: string; loading: boolean; error?: string }) {
  return (
    <Link href={href} className="hq-kpi">
      <Card>
        <p className="hq-kpi__l">{label}</p>
        <p className="hq-kpi__v">{loading ? "…" : error ? "–" : value}</p>
        <p className="hq-kpi__l">{error ? "Could not load" : extra ?? " "}</p>
      </Card>
    </Link>
  );
}
