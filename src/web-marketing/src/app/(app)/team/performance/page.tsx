"use client";
import { PageHeader } from "@chilli/ui";
import { DataTable } from "@chilli/ui/data";
import { api } from "@/lib/api";
import { useAuth } from "@/components/auth";
import { AsyncView, SubNav, NoAccess } from "@/components/ui";
import { TEAM_NAV } from "@/components/subnavs";
import { useQuery } from "@/lib/hooks";
import { fetchAll } from "@/lib/fetchAll";
import { buildPerformance, type PerfRow } from "@/lib/performance";
import { can, ROLE_LABEL } from "@/lib/roles";
import { fmtMoney, fmtPct } from "@/lib/format";

const totalMajor = (m: Record<string, number>) => Object.values(m).reduce((a, b) => a + b, 0) / 100;
const money = (m: Record<string, number>) => { const e = Object.entries(m); return e.length ? e.map(([c, v]) => fmtMoney(v, c)).join(", ") : "—"; };

export default function PerformancePage() {
  const { user } = useAuth();
  const admin = can(user?.role, "team.manage");
  const q = useQuery(`performance:${admin}`, async () => {
    if (!admin) return [];
    const [users, leads, apps, entries] = await Promise.all([
      api.users.list(), fetchAll((offset, limit) => api.leads.list({ limit, offset })),
      fetchAll((offset, limit) => api.onboarding.list({ limit, offset })), fetchAll((offset, limit) => api.commissions.entries({ limit, offset })),
    ]);
    return buildPerformance(users, leads, apps, entries);
  });
  if (!admin) return <NoAccess role={user?.role} what="Team performance" />;
  return (
    <div className="stack">
      <PageHeader title="Team performance" description="Leads, wins and commission per person. Conversion is won / all leads owned." />
      <SubNav items={TEAM_NAV} />
      <AsyncView q={q} isEmpty={(d) => d.length === 0} empty={{ title: "No team members yet" }}>
        {(rows) => (
          <DataTable<PerfRow> caption="Performance by person" exportName="team-performance" getKey={(r) => r.user.id} rows={rows}
            columns={[
              { key: "n", header: "Person", render: (r) => <><strong>{r.user.name}</strong><br /><span className="small muted">{ROLE_LABEL[r.user.role]}</span></>, sortValue: (r) => r.user.name },
              { key: "l", header: "Leads", align: "end", render: (r) => r.leads, sortValue: (r) => r.leads },
              { key: "w", header: "Won", align: "end", render: (r) => r.won, sortValue: (r) => r.won },
              { key: "c", header: "Conversion %", align: "end", render: (r) => (r.leads ? fmtPct(r.conversionBps) : "—"), sortValue: (r) => r.conversionBps, csv: (r) => r.conversionBps / 100 },
              { key: "a", header: "Provisioned", align: "end", render: (r) => (r.applications ? `${r.provisioned}/${r.applications}` : "—"), csv: (r) => r.provisioned },
              { key: "p", header: "Pending", align: "end", render: (r) => money(r.pending), csv: (r) => totalMajor(r.pending) },
              { key: "ap", header: "Approved", align: "end", render: (r) => money(r.approved), csv: (r) => totalMajor(r.approved) },
              { key: "pd", header: "Paid", align: "end", render: (r) => money(r.paid), csv: (r) => totalMajor(r.paid) },
            ]} />
      )}
      </AsyncView>
    </div>
  );
}
