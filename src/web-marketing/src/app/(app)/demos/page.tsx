"use client";
import Link from "next/link";
import { FilterBar } from "@chilli/ui/data";
import { useState } from "react";
import { Button, Card, Select, useToast, PageHeader } from "@chilli/ui";
import { api } from "@/lib/api";
import { useAuth } from "@/components/auth";
import { AsyncView, DemoBadge, FormError, SubNav } from "@/components/ui";
import { leadsNav } from "@/components/subnavs";
import { useAction, useQuery } from "@/lib/hooks";
import { can } from "@/lib/roles";
import { fmtDateTime } from "@/lib/format";
import type { DemoStatus } from "@/lib/api/types";

export default function DemosPage() {
  const { user } = useAuth();
  const toast = useToast();
  const [status, setStatus] = useState<DemoStatus | "">("scheduled");
  const q = useQuery(`demos:${status}`, () => api.demos.list({ status: status || undefined, limit: 200 }));
  const { run, busy, error } = useAction();
  const canEdit = can(user?.role, "lead.write");
  async function mark(id: string, s: DemoStatus) {
    if (await run(() => api.demos.update(id, { status: s }))) { toast.show(`Demo marked ${s.replace("_", " ")}`, "success"); q.reload(); }
  }
  return (
    <div className="stack">
      <PageHeader title="Demos" description="Schedule a demo from a lead. Completing it moves the lead to Demo done." />
      <SubNav items={leadsNav(user?.role)} />
      <FilterBar>
        <Select label="Status" value={status} onChange={(e) => setStatus(e.target.value as DemoStatus | "")}>
          <option value="scheduled">Upcoming</option><option value="completed">Completed</option><option value="no_show">No show</option><option value="cancelled">Cancelled</option><option value="">All</option>
        </Select>
      </FilterBar>
      <FormError error={error} />
      <AsyncView q={q} isEmpty={(d) => d.length === 0} empty={{ title: "No demos", description: "Open a lead and choose Schedule demo." }}>
        {(rows) => (
          <Card>
            <ul className="list">
              {rows.map((d) => (
                <li key={d.id}>
                  <span className="grow">
                    <Link href={`/leads/${d.lead_id}`} className="title">{fmtDateTime(d.scheduled_at)} · {d.duration_minutes} min</Link><br />
                    <span className="small muted">{d.mode === "online" ? "Online" : d.location ?? "On site"}</span>
                  </span>
                  <DemoBadge status={d.status} />
                  {canEdit && d.status === "scheduled" && (
                    <span className="row"><Button size="sm" disabled={busy} onClick={() => mark(d.id, "completed")}>Completed</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => mark(d.id, "no_show")}>No show</Button></span>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        )}
      </AsyncView>
    </div>
  );
}
