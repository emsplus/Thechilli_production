"use client";
import { useState } from "react";
import { Select, Table, formatINR } from "@chilli/ui";
import { api } from "@/lib/api";
import type { Balances, CommissionEntry, MarketingMember, MarketingReferral } from "@/lib/api/types";
import { fmtDate, fmtNumber } from "@/lib/format";
import { useResource } from "@/lib/useResource";
import { Notice, PageHeader, ResourceView, StatusBadge } from "@/components/ui";

const money = (minor: number, cur: string) => (cur === "INR" ? formatINR(minor) : `${(minor / 100).toFixed(2)} ${cur}`);
const bal = (b: Balances, k: "pending_minor" | "approved_minor" | "paid_minor") => {
  const e = Object.entries(b);
  return e.length ? e.map(([cur, v]) => money(v[k], cur)).join(", ") : "–";
};

/** Read-only view of Portal C's team, referral codes and commissions, aggregated by platform-core. Decisions stay in Portal C. */
export default function MarketingPage() {
  const [status, setStatus] = useState("");
  const team = useResource(() => api.marketing.team(), "mk-team");
  const refs = useResource(() => api.marketing.referrals(), "mk-refs");
  const com = useResource(() => api.marketing.commissions(status || undefined), `mk-com-${status}`);
  return (
    <>
      <PageHeader title="Marketing team" subtitle="People, referral codes and commissions from the Partner portal. Read-only here: approve and pay in the Partner portal." />
      <Notice>Amounts are in rupees, net of reversals. Rejected entries are not counted.</Notice>
      <h2 className="hq-h2">Team</h2>
      <ResourceView res={team} isEmpty={(d) => d.items.length === 0} empty={{ title: "No marketing users" }}>
        {(d) => (
          <Table<MarketingMember> caption="Marketing team" getKey={(m) => m.id} rows={d.items} columns={[
            { key: "n", header: "Name", render: (m) => <>{m.name}<br /><span className="hq-muted">{m.email}</span></> },
            { key: "r", header: "Role", render: (m) => m.role.replace(/_/g, " ") },
            { key: "s", header: "Status", render: (m) => <StatusBadge value={m.is_active ? "active" : "inactive"} /> },
            { key: "c", header: "Referral codes", render: (m) => `${m.referral_codes} (${fmtNumber(m.referral_uses)} uses)` },
            { key: "p", header: "Pending", render: (m) => bal(m.commission, "pending_minor") },
            { key: "a", header: "Approved", render: (m) => bal(m.commission, "approved_minor") },
            { key: "d", header: "Paid", render: (m) => bal(m.commission, "paid_minor") },
          ]} />
        )}
      </ResourceView>
      <h2 className="hq-h2">Referral codes</h2>
      <ResourceView res={refs} isEmpty={(d) => d.items.length === 0} empty={{ title: "No referral codes yet" }}>
        {(d) => (
          <Table<MarketingReferral> caption="Referral codes" getKey={(r) => r.id} rows={d.items} columns={[
            { key: "c", header: "Code", render: (r) => <span className="hq-mono">{r.code}</span> }, { key: "o", header: "Owner", render: (r) => r.owner_name ?? "–" },
            { key: "u", header: "Uses", render: (r) => (r.max_uses ? `${r.uses} / ${r.max_uses}` : String(r.uses)) },
            { key: "e", header: "Expires", render: (r) => fmtDate(r.expires_at) }, { key: "s", header: "Status", render: (r) => <StatusBadge value={r.is_active ? "active" : "inactive"} /> },
          ]} />
        )}
      </ResourceView>
      <h2 className="hq-h2">Commissions</h2>
      <div className="hq-filters"><Select label="Status" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option>{["pending", "approved", "paid", "rejected"].map((s) => <option key={s} value={s}>{s}</option>)}</Select></div>
      <ResourceView res={com} isEmpty={(d) => d.items.length === 0} empty={{ title: "No commission entries" }}>
        {(d) => (
          <>
            <p className="hq-sub">Totals: pending {bal(d.balances, "pending_minor")} · approved {bal(d.balances, "approved_minor")} · paid {bal(d.balances, "paid_minor")}</p>
            <Table<CommissionEntry> caption="Commission entries" getKey={(e) => e.id} rows={d.items} columns={[
              { key: "d", header: "Created", render: (e) => fmtDate(e.created_at) }, { key: "u", header: "Person", render: (e) => e.user_name ?? "–" },
              { key: "k", header: "Kind", render: (e) => e.kind }, { key: "b", header: "Base", render: (e) => money(e.base_amount_minor, e.currency) },
              { key: "a", header: "Amount", render: (e) => money(e.amount_minor, e.currency) }, { key: "s", header: "Status", render: (e) => <StatusBadge value={e.status} /> },
            ]} />
            {d.rules.length ? <p className="hq-sub">Active rules: {d.rules.filter((r) => r.is_active).map((r) => r.name).join(", ") || "none"}</p> : null}
          </>
        )}
      </ResourceView>
    </>
  );
}
