"use client";
import { useState } from "react";
import { Badge, Button, Money, Select, Sheet, Table, useToast } from "@chilli/ui";
import { api, ApiError } from "@/lib/api";
import type { Invoice } from "@/lib/api/types";
import { fmtDate } from "@/lib/format";
import { useTenants } from "@/lib/hooks";
import { useCan } from "@/lib/session";
import { useAction, useResource } from "@/lib/useResource";
import { Notice, PageHeader, Pager, ReasonDialog, ResourceView, StatusBadge } from "@/components/ui";
import { TenantLink } from "@/components/TenantLink";
import { CA_NOTICE, InvoiceBody } from "@/components/InvoiceParts";

export default function InvoicesPage() {
  const [status, setStatus] = useState("");
  const [offset, setOffset] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const { nameOf } = useTenants();
  const res = useResource(() => api.billing.invoices({ status: status || undefined, offset }), `${status}|${offset}`);
  return (
    <>
      <PageHeader title="Invoices" subtitle="Subscription invoices raised by Chilli. Amounts in rupees, GST included in totals." />
      <Notice tone="warning">{CA_NOTICE}</Notice>
      <div className="hq-filters">
        <Select label="Status" value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }}>
          <option value="">All</option>{["draft", "issued", "paid", "void"].map((s) => <option key={s} value={s}>{s}</option>)}
        </Select>
      </div>
      <ResourceView res={res} isEmpty={(d) => d.items.length === 0} empty={{ title: "No invoices", description: status ? "Nothing with this status." : "Invoices appear once a subscription is billed.", actionLabel: status ? "Show all" : undefined, onAction: () => setStatus("") }}>
        {(d) => (
          <>
            <Table<Invoice> caption="Invoices" getKey={(i) => i.id} rows={d.items} columns={[
              { key: "n", header: "Number", render: (i) => <Button size="sm" variant="ghost" onClick={() => setOpenId(i.id)}><span className="hq-nowrap">{i.number ?? "Draft"}</span></Button> },
              { key: "t", header: "Business", render: (i) => <TenantLink id={i.tenant_id} name={nameOf(i.tenant_id)} /> },
              { key: "s", header: "Status", render: (i) => <StatusBadge value={i.status} /> },
              { key: "d", header: "Issued", render: (i) => fmtDate(i.issued_at) },
              { key: "a", header: "Total", align: "end", render: (i) => <Money value={i.total_paise} alwaysDecimals /> },
              { key: "ca", header: "GST", render: (i) => (i.tax_needs_ca_verification ? <Badge tone="warning">CA verification pending</Badge> : <Badge tone="success">Verified</Badge>) },
            ]} />
            <Pager page={d} onOffset={setOffset} />
          </>
        )}
      </ResourceView>
      {openId ? <InvoiceSheet id={openId} onClose={() => setOpenId(null)} onChanged={res.reload} nameOf={nameOf} /> : null}
    </>
  );
}

function InvoiceSheet({ id, onClose, onChanged, nameOf }: { id: string; onClose: () => void; onChanged: () => void; nameOf: (id: string) => string }) {
  const can = useCan();
  const toast = useToast();
  const res = useResource(() => api.billing.invoice(id), id);
  const [voiding, setVoiding] = useState(false);
  const issue = useAction(async () => { await api.billing.issue(id); toast.show("Invoice issued", "success"); res.reload(); onChanged(); });
  const i = res.data;
  const manage = can("invoices.manage");
  return (
    <Sheet side="right" open onOpenChange={(o) => !o && onClose()} title={i ? `Invoice ${i.number ?? "(draft)"}` : "Invoice"}
      footer={i && manage ? <>
        {i.status === "draft" || i.status === "issued" ? <Button variant="danger-soft" onClick={() => setVoiding(true)}>Void</Button> : null}
        {i.status === "draft" ? <Button variant="primary" loading={issue.busy} onClick={() => void issue.run()}>Issue invoice</Button> : null}
      </> : undefined}>
      <ResourceView res={res} isEmpty={() => false} empty={{ title: "" }}>{(d) => <InvoiceBody d={d} name={nameOf(d.tenant_id)} error={issue.error} />}</ResourceView>
      {voiding ? <ReasonDialog open onOpenChange={(o) => !o && setVoiding(false)} title="Void invoice" description="A voided invoice cannot be reopened. Payments must be refunded first." confirmLabel="Void invoice"
        onConfirm={async (reason): Promise<ApiError | undefined> => { try { await api.billing.void(id, reason); toast.show("Invoice voided", "success"); res.reload(); onChanged(); } catch (e) { return e as ApiError; } }} /> : null}
    </Sheet>
  );
}

