"use client";
import { useState } from "react";
import { Select, Table } from "@chilli/ui";
import { api } from "@/lib/api";
import type { SecurityEvent } from "@/lib/api/types";
import { fmtDateTime, fmtDetails, titleCase } from "@/lib/format";
import { useResource } from "@/lib/useResource";
import { PageHeader, Pager, ResourceView, StatusBadge } from "@/components/ui";

export default function SecurityEventsPage() {
  const [severity, setSeverity] = useState("");
  const [offset, setOffset] = useState(0);
  const res = useResource(() => api.logs.security({ severity: severity || undefined, offset }), `${severity}|${offset}`);
  return (
    <>
      <PageHeader title="Security events" subtitle="Sign-ins, lockouts, role changes and support-access use." />
      <div className="hq-filters">
        <Select label="Severity" value={severity} onChange={(e) => { setSeverity(e.target.value); setOffset(0); }}>
          <option value="">All</option><option value="info">Info</option><option value="warn">Warning</option><option value="critical">Critical</option>
        </Select>
      </div>
      <ResourceView res={res} isEmpty={(d) => d.items.length === 0} empty={{ title: "No security events", description: severity ? "Nothing at this severity." : "Quiet is good.", actionLabel: severity ? "Show all" : undefined, onAction: () => setSeverity("") }}>
        {(d) => (
          <>
            <Table<SecurityEvent> caption="Security events" getKey={(e) => String(e.id)} rows={d.items} columns={[
              { key: "w", header: "When", render: (e) => fmtDateTime(e.at) }, { key: "s", header: "Severity", render: (e) => <StatusBadge value={e.severity} /> },
              { key: "t", header: "Event", render: (e) => titleCase(e.type) }, { key: "u", header: "Account", render: (e) => e.email ?? "–" }, { key: "ip", header: "IP", render: (e) => e.ip ?? "–" },
              { key: "d", header: "Details", render: (e) => (fmtDetails(e.details) || "–") },
            ]} />
            <Pager page={d} onOffset={setOffset} />
          </>
        )}
      </ResourceView>
    </>
  );
}
