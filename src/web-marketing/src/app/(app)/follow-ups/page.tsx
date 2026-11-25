"use client";
import Link from "next/link";
import { FilterBar } from "@chilli/ui/data";
import { useState } from "react";
import { Button, Card, Notice, PageHeader, Select, useToast } from "@chilli/ui";
import { api } from "@/lib/api";
import { useAuth } from "@/components/auth";
import { AsyncView } from "@/components/ui";
import { useAction, useQuery } from "@/lib/hooks";
import { fmtDateTime, isOverdue } from "@/lib/format";
import type { ActivityQuery } from "@/lib/api/types";

type Status = NonNullable<ActivityQuery["status"]>;

export default function FollowUpsPage() {
  const { user } = useAuth();
  const toast = useToast();
  const [status, setStatus] = useState<Status>("pending");
  const [mine, setMine] = useState(true);
  const q = useQuery(`followups:${status}:${mine}`, () => api.activities.list({ status, mine, limit: 200 }));
  const { run, busy, error } = useAction();
  return (
    <div className="stack">
      <PageHeader title="Follow-ups" description="Calls, visits and messages you planned." />
      <FilterBar>
        <Select label="Show" value={status} onChange={(e) => setStatus(e.target.value as Status)}>
          <option value="pending">Upcoming</option><option value="overdue">Overdue</option><option value="completed">Done</option><option value="all">All</option>
        </Select>
        {user?.role === "marketing_admin" && <Select label="Whose" value={mine ? "mine" : "all"} onChange={(e) => setMine(e.target.value === "mine")}><option value="mine">Mine</option><option value="all">Everyone</option></Select>}
      </FilterBar>
      {error && <Notice tone="danger">{error.message}</Notice>}
      <AsyncView q={q} isEmpty={(d) => d.length === 0} empty={{ title: "No follow-ups here", description: "Open a lead and log a follow-up with a due time." }}>
        {(rows) => (
          <Card>
            <ul className="list">
              {rows.map((a) => (
                <li key={a.id}>
                  <span className="grow">
                    <Link href={`/leads/${a.lead_id}`} className="title">{a.summary}</Link><br />
                    <span className="small muted">{a.type.replace("_", " ")} · {a.completed_at ? `done ${fmtDateTime(a.completed_at)}` : `due ${fmtDateTime(a.due_at)}`}</span>
                    {!a.completed_at && isOverdue(a.due_at) && <span className="small" style={{ color: "var(--c-danger-fg)" }}> · overdue</span>}
                  </span>
                  {!a.completed_at && <Button size="sm" disabled={busy} onClick={async () => { if (await run(() => api.activities.complete(a.id))) { toast.show("Marked done", "success"); q.reload(); } }}>Done</Button>}
                </li>
              ))}
            </ul>
          </Card>
        )}
      </AsyncView>
    </div>
  );
}
