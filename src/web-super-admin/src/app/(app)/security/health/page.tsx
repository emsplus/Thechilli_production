"use client";
import { Card, Table } from "@chilli/ui";
import { api } from "@/lib/api";
import type { JobHealth } from "@/lib/api/types";
import { timeAgo } from "@/lib/format";
import { useResource } from "@/lib/useResource";
import { DefList, PageHeader, ResourceView, StatusBadge } from "@/components/ui";
import { Button } from "@chilli/ui";

export default function HealthPage() {
  const res = useResource(() => api.system.health(), "health");
  return (
    <>
      <PageHeader title="System health" subtitle="Platform services and background jobs." actions={<Button onClick={res.reload} loading={res.loading && res.data !== undefined}>Refresh</Button>} />
      <ResourceView res={res} isEmpty={() => false} empty={{ title: "" }}>
        {(h) => (
          <>
            <Card as="section" style={{ marginBottom: 16 }}>
              <DefList items={[["Overall", <StatusBadge key="o" value={h.status} />], ["Database", <StatusBadge key="d" value={h.database} />], ["Environment", h.environment], ["Signing key", <span key="k" className="hq-mono">{h.signing_key_id}</span>], ["Failed onboardings", String(h.failed_onboardings)], ["Checked", timeAgo(h.checked_at)]]} />
            </Card>
            <Table<JobHealth> caption="Background jobs" getKey={(j) => `${j.service}/${j.job_name}`} rows={h.jobs} empty={<p className="hq-muted">No services have reported a heartbeat yet.</p>} columns={[
              { key: "j", header: "Job", render: (j) => j.job_name }, { key: "s", header: "Service", render: (j) => j.service },
              { key: "h", header: "State", render: (j) => <StatusBadge value={j.healthy ? "healthy" : j.stale ? "stale" : "error"} /> },
              { key: "l", header: "Last seen", render: (j) => timeAgo(j.last_seen_at) }, { key: "e", header: "Expected every", render: (j) => `${Math.round(j.expected_interval_seconds / 60)} min` },
              { key: "d", header: "Last run", render: (j) => (j.last_duration_ms === null ? "–" : `${j.last_duration_ms} ms`) },
            ]} />
          </>
        )}
      </ResourceView>
    </>
  );
}
