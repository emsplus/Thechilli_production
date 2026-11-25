"use client";
import Link from "next/link";
import { FilterBar } from "@chilli/ui/data";
import { useState } from "react";
import { Badge, Button, Card, Dialog, PageHeader, Select, Textarea, useToast, StatCard } from "@chilli/ui";
import { api } from "@/lib/api";
import { useAuth } from "@/components/auth";
import { AsyncView, EntryBadge, FormError, SubNav } from "@/components/ui";
import { earningsNav } from "@/components/subnavs";
import { useAction, useQuery } from "@/lib/hooks";
import { usePeople } from "@/lib/people";
import { can, nextEntryActions } from "@/lib/roles";
import { fmtDate, fmtMoney } from "@/lib/format";
import type { EntryOut, EntryStatus } from "@/lib/api/types";

type Act = "approve" | "reject" | "pay" | "reverse";

export default function EarningsPage() {
  const { user } = useAuth();
  const toast = useToast();
  const { name } = usePeople();
  const [status, setStatus] = useState<EntryStatus | "">("");
  const summary = useQuery("comm-summary", () => api.commissions.summary());
  const entries = useQuery(`entries:${status}`, () => api.commissions.entries({ status: status || undefined, limit: 200 }));
  const { run, busy, error } = useAction();
  const [dlg, setDlg] = useState<{ act: Act; entry: EntryOut } | null>(null);
  const [note, setNote] = useState("");
  const admin = can(user?.role, "commission.decide");

  async function exec(act: Act, e: EntryOut, n?: string) {
    const r = await run(() => api.commissions[act](e.id, n));
    if (r) { toast.show(({ approve: "Approved", reject: "Rejected", pay: "Marked paid", reverse: "Reversed" } as const)[act], "success"); entries.reload(); summary.reload(); }
  }
  return (
    <div className="stack">
      <PageHeader title="Earnings" description={admin ? "Review commissions. You cannot decide your own." : "Your commission entries and balances."} />
      <SubNav items={earningsNav(user?.role)} />
      <AsyncView q={summary} rows={1} isEmpty={(d) => Object.keys(d.balances).length === 0} empty={{ title: "No earnings yet", description: "Commission appears here after a business you brought in is provisioned." }}>
        {(s) => (
          <>{Object.entries(s.balances).map(([cur, b]) => (
            <div key={cur} className="grid kpis" aria-label={`Your balances in ${cur}`}>
              <StatCard label="Your pending" value={fmtMoney(b.pending_minor, cur, { compact: true })} /><StatCard label="Your approved" value={fmtMoney(b.approved_minor, cur, { compact: true })} /><StatCard label="Your paid" value={fmtMoney(b.paid_minor, cur, { compact: true })} />
            </div>))}</>
        )}
      </AsyncView>
      <FilterBar>
        <Select label="Status" value={status} onChange={(e) => setStatus(e.target.value as EntryStatus | "")}>
          <option value="">All</option><option value="pending">Pending</option><option value="approved">Approved</option><option value="paid">Paid</option><option value="rejected">Rejected</option>
        </Select>
      </FilterBar>
      <FormError error={error} />
      <AsyncView q={entries} isEmpty={(d) => d.length === 0} empty={{ title: "No ledger entries", description: status ? "Nothing with this status." : "Entries are created when a business is provisioned." }}>
        {(rows) => (
          <Card>
            <ul className="list">
              {rows.map((e) => {
                const actions = nextEntryActions(user?.role, user?.id, e);
                const own = admin && e.user_id === user?.id && e.kind === "commission" && (e.status === "pending" || e.status === "approved");
                return (
                  <li key={e.id}>
                    <span className="grow">
                      <span className="title">{fmtMoney(e.amount_minor, e.currency)}</span> {e.kind === "reversal" && <Badge tone="neutral">reversal</Badge>}<br />
                      <span className="small muted">{admin ? `${name(e.user_id)} · ` : ""}{fmtDate(e.created_at)}{e.application_id && <> · <Link href={`/onboarding/${e.application_id}`}>application</Link></>}{e.note ? ` · ${e.note}` : ""}</span>
                      {own && <><br /><span className="small" style={{ color: "var(--c-warning-fg)" }}>Your own entry: another admin must decide it.</span></>}
                    </span>
                    <EntryBadge status={e.status} />
                    {actions.length > 0 && (
                      <span className="row">
                        {actions.includes("approve") && <Button size="sm" disabled={busy} onClick={() => exec("approve", e)}>Approve</Button>}
                        {actions.includes("reject") && <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setNote(""); setDlg({ act: "reject", entry: e }); }}>Reject</Button>}
                        {actions.includes("pay") && <Button size="sm" disabled={busy} onClick={() => exec("pay", e)}>Mark paid</Button>}
                      </span>
                    )}
                    {admin && e.kind === "commission" && (e.status === "approved" || e.status === "paid") && e.user_id !== user?.id && (
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setNote(""); setDlg({ act: "reverse", entry: e }); }}>Reverse</Button>
                    )}
                  </li>
                );
              })}
            </ul>
          </Card>
        )}
      </AsyncView>
      <Dialog open={!!dlg} onOpenChange={(o) => !o && setDlg(null)} title={dlg?.act === "reverse" ? "Reverse this entry?" : "Reject this entry?"}
        description={dlg?.act === "reverse" ? "A negative entry is added. The original is never edited." : "The salesperson will see it as rejected."}
        footer={<><Button variant="ghost" onClick={() => setDlg(null)}>Cancel</Button><Button variant="danger-soft" onClick={() => { const d = dlg!; setDlg(null); void exec(d.act, d.entry, note.trim() || undefined); }}>{dlg?.act === "reverse" ? "Reverse" : "Reject"}</Button></>}>
        <Textarea label="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
      </Dialog>
    </div>
  );
}
