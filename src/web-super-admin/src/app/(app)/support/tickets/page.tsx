"use client";
import { useState } from "react";
import { Button, Select, Sheet, Table, useToast } from "@chilli/ui";
import { api } from "@/lib/api";
import type { Ticket, TicketPriority, TicketStatus } from "@/lib/api/types";
import { fmtDateTime, timeAgo, titleCase } from "@/lib/format";
import { useTenants } from "@/lib/hooks";
import { useCan } from "@/lib/session";
import { useAction, useResource } from "@/lib/useResource";
import { DefList, InlineError, PageHeader, Pager, ResourceView, StatusBadge, TextArea } from "@/components/ui";
import { TenantLink } from "@/components/TenantLink";

const STATUSES: TicketStatus[] = ["open", "in_progress", "waiting", "resolved", "closed"];
const PRIORITIES: TicketPriority[] = ["low", "normal", "high", "urgent"];

export default function TicketsPage() {
  const [status, setStatus] = useState("");
  const [offset, setOffset] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const { nameOf } = useTenants();
  const res = useResource(() => api.support.tickets({ status: status || undefined, offset }), `${status}|${offset}`);
  return (
    <>
      <PageHeader title="Support tickets" subtitle="Requests from businesses to the Chilli team." />
      <div className="hq-filters">
        <Select label="Status" value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }}>
          <option value="">All</option>{STATUSES.map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
        </Select>
      </div>
      <ResourceView res={res} isEmpty={(d) => d.items.length === 0} empty={{ title: "No tickets", description: status ? "Nothing with this status." : "Nothing waiting on support.", actionLabel: status ? "Show all" : undefined, onAction: () => setStatus("") }}>
        {(d) => (
          <>
            <Table<Ticket> caption="Support tickets" getKey={(t) => t.id} rows={d.items} columns={[
              { key: "s", header: "Subject", render: (t) => <Button size="sm" variant="ghost" onClick={() => setOpenId(t.id)}>{t.subject}</Button> },
              { key: "b", header: "Business", render: (t) => (t.tenant_id ? <TenantLink id={t.tenant_id} name={nameOf(t.tenant_id)} /> : <span className="hq-muted">Not linked</span>) },
              { key: "p", header: "Priority", render: (t) => <StatusBadge value={t.priority} /> }, { key: "st", header: "Status", render: (t) => <StatusBadge value={t.status} /> },
              { key: "u", header: "Updated", render: (t) => timeAgo(t.updated_at) },
            ]} />
            <Pager page={d} onOffset={setOffset} />
          </>
        )}
      </ResourceView>
      {openId ? <TicketSheet id={openId} onClose={() => setOpenId(null)} onChanged={res.reload} nameOf={nameOf} /> : null}
    </>
  );
}

function TicketSheet({ id, onClose, onChanged, nameOf }: { id: string; onClose: () => void; onChanged: () => void; nameOf: (id: string) => string }) {
  const can = useCan();
  const toast = useToast();
  const res = useResource(() => api.support.ticket(id), id);
  const [body, setBody] = useState("");
  const [internal, setInternal] = useState(true);
  const upd = useAction(async (b: { status?: TicketStatus; priority?: TicketPriority }) => { await api.support.updateTicket(id, b); res.reload(); onChanged(); });
  const add = useAction(async () => { await api.support.comment(id, { body: body.trim(), internal }); setBody(""); toast.show("Comment added", "success"); res.reload(); });
  const manage = can("tickets.manage");
  return (
    <Sheet side="right" open onOpenChange={(o) => !o && onClose()} title={res.data?.subject ?? "Ticket"}>
      <ResourceView res={res} isEmpty={() => false} empty={{ title: "" }}>
        {(t) => (
          <div className="hq-stack">
            <DefList items={[["Business", t.tenant_id ? nameOf(t.tenant_id) : "Not linked"], ["Requester", t.requester_email], ["Opened", fmtDateTime(t.created_at)], ["By", t.created_by]]} />
            <p>{t.body}</p>
            {manage ? (
              <div className="hq-row">
                <Select label="Status" value={t.status} onChange={(e) => void upd.run({ status: e.target.value as TicketStatus })}>{STATUSES.map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}</Select>
                <Select label="Priority" value={t.priority} onChange={(e) => void upd.run({ priority: e.target.value as TicketPriority })}>{PRIORITIES.map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}</Select>
              </div>
            ) : null}
            <InlineError error={upd.error} />
            <h3 className="hq-card-title">Conversation</h3>
            {t.comments.length === 0 ? <p className="hq-muted">No comments yet.</p> : (
              <ul>{t.comments.map((c) => <li key={c.id}><strong>{c.author}</strong> · {fmtDateTime(c.created_at)} {c.internal ? <em>(internal note)</em> : null}<br />{c.body}</li>)}</ul>
            )}
            {manage ? (
              <form onSubmit={(e) => { e.preventDefault(); if (body.trim()) void add.run(); }}>
                <TextArea label="Add comment" value={body} onChange={setBody} />
                <label className="hq-check"><input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} /> Internal note (not shown to the business)</label>
                <InlineError error={add.error} />
                <p><Button type="submit" variant="primary" loading={add.busy} disabled={!body.trim()}>Add comment</Button></p>
              </form>
            ) : null}
          </div>
        )}
      </ResourceView>
    </Sheet>
  );
}
