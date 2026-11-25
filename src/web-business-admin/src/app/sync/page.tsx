"use client";

import { formatDateTime, formatTime } from "@/lib/datetime";
import { Badge, Button, Notice, PageHeader } from "@chilli/ui";
import { useMemo, useState } from "react";
import { motion } from "motion/react";
import { Banknote, ChefHat, ClipboardList, CreditCard, Plus, RefreshCw, ReceiptText, Trash2, type LucideIcon } from "lucide-react";
import { Card, EmptyState, StatusPill, toast, useConfirm } from "@/components/ui";
import { SuccessCheckIllustration } from "@/components/illustrations";
import { cn } from "@/lib/cn";
import type { OpStatus, QueuedOp } from "@/lib/offlineDb";
import { acceptPriceChanges, belongsToSession, discardOrder, flush, retry } from "@/lib/sync";
import { useSyncStatus } from "@/lib/useSyncStatus";

interface Group { ref: string; shortRef: string; ops: QueuedOp[]; status: OpStatus; latest: number }

const PRIORITY: OpStatus[] = ["conflict", "failed", "syncing", "pending", "synced"];
const ICON: Record<QueuedOp["op"]["type"], { icon: LucideIcon; name: string }> = {
  create_order: { icon: ClipboardList, name: "Order" },
  add_lines: { icon: Plus, name: "Added items" },
  send_kot: { icon: ChefHat, name: "Kitchen ticket" },
  finalize_bill: { icon: ReceiptText, name: "Bill" },
  payment: { icon: Banknote, name: "Payment" },
};

function groupOps(ops: QueuedOp[]): Group[] {
  const m = new Map<string, QueuedOp[]>();
  for (const o of ops) m.set(o.order_ref, [...(m.get(o.order_ref) ?? []), o]);
  return [...m.entries()].map(([ref, list]) => {
    const sorted = [...list].sort((a, b) => a.seq - b.seq);
    const status = PRIORITY.find((p) => sorted.some((o) => o.status === p)) ?? "synced";
    return { ref, shortRef: `OFF-${ref.slice(0, 6).toUpperCase()}`, ops: sorted, status, latest: sorted[sorted.length - 1].seq };
  }).sort((a, b) => b.latest - a.latest);
}

function Step({ op, last }: { op: QueuedOp; last: boolean }) {
  const { icon: Icon, name } = ICON[op.op.type];
  const PayIcon = op.op.type === "payment" && op.op.method === "card" ? CreditCard : Icon;
  const tone = op.status === "synced" ? "bg-success-soft text-success-fg" : op.status === "failed" || op.status === "conflict" ? "bg-danger-soft text-danger-fg" : op.status === "syncing" ? "bg-info-soft text-info-fg" : "bg-warning-soft text-warning-fg";
  return (
    <li className="relative flex gap-3 pb-4 last:pb-0">
      {!last && <span aria-hidden className="absolute left-[1.0625rem] top-9 h-[calc(100%-2.25rem)] w-px bg-border-strong" />}
      <span className={cn("grid size-9 shrink-0 place-items-center rounded-full", tone)}><PayIcon className="size-4" aria-hidden /></span>
      <div className="min-w-0 flex-1 pt-0.5">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <p className="text-sm font-semibold text-fg">{name}<span className="ml-2 text-xs font-normal text-fg-subtle">{formatTime(op.created_at, undefined, true)}</span></p>
          <StatusPill kind="sync" status={op.status} size="sm" />
        </div>
        <p className="text-xs text-fg-muted">{op.label}{op.attempts > 1 && ` · ${op.attempts} attempts`}</p>
        {op.error && !op.conflicts?.length && op.status !== "pending" && op.status !== "synced" && <p className="mt-1 text-xs font-medium text-danger-fg">{op.error}</p>}
        {op.conflicts && op.conflicts.length > 0 && (
          <div className="mt-2 rounded-lg bg-warning-soft p-3 text-sm text-warning-fg">
            <p className="font-semibold">Prices changed while this order was offline</p>
            <ul className="mt-1 space-y-0.5">
              {op.conflicts.map((c, i) => <li key={i}>{c.item}: price was {c.expected} when taken, now {c.current}</li>)}
            </ul>
            <p className="mt-1.5 text-xs opacity-90">Accepting uses the current prices, so the customer pays the new amount. Discarding removes the sale from this device without recording it.</p>
          </div>
        )}
      </div>
    </li>
  );
}

function OrderCard({ g }: { g: Group }) {
  const confirm = useConfirm();
  const create = g.ops.find((o) => o.op.type === "create_order");
  const meta = create && create.op.type === "create_order" ? create.op.order : null;
  const itemCount = meta ? meta.lines.reduce((n, l) => n + l.quantity, 0) : null;
  const needsReview = g.ops.some((o) => o.status === "conflict");
  const failed = g.ops.some((o) => o.status === "failed");

  async function discard() {
    const ok = await confirm({ title: "Discard this offline order?", tone: "danger", confirmLabel: "Discard order", cancelLabel: "Keep",
      description: `${g.shortRef} was taken on this device but has not reached the server. If you discard it the sale will NOT be recorded.` });
    if (ok) { await discardOrder(g.ref); toast.success("Offline order discarded"); }
  }

  return (
    <motion.li layout="position" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }} data-testid="queue-item">
      <Card className={cn(g.status === "conflict" || g.status === "failed" ? "border-danger/40" : g.status === "synced" && "opacity-80")}>
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="font-mono text-base font-semibold text-fg">{g.shortRef}</h2>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-fg-muted">
              {meta && <Badge tone="neutral" className="capitalize">{meta.order_type}</Badge>}
              {itemCount !== null && <span>{itemCount} {itemCount === 1 ? "item" : "items"}</span>}
              <span>Taken {formatDateTime(g.ops[0].created_at)}</span>
            </p>
          </div>
          <StatusPill kind="sync" status={g.status} />
        </div>
        <ol aria-label={`Steps for ${g.shortRef}`}>{g.ops.map((o, i) => <Step key={o.op_id} op={o} last={i === g.ops.length - 1} />)}</ol>
        {(needsReview || failed) && (
          <div className="mt-4 flex flex-col-reverse gap-2 border-t border-border pt-4 sm:flex-row sm:justify-end">
            <Button variant="danger-soft" iconStart={<Trash2 />} onClick={() => void discard()}>Discard</Button>
            {failed && !needsReview && <Button variant="secondary" iconStart={<RefreshCw />} onClick={() => void retry(g.ref)}>Retry</Button>}
            {needsReview && <Button variant="primary" onClick={() => void acceptPriceChanges(g.ref)}>Accept current prices</Button>}
          </div>
        )}
      </Card>
    </motion.li>
  );
}

export default function SyncPage() {
  const s = useSyncStatus();
  const groups = useMemo(() => groupOps(s.ops), [s.ops]);
  const [syncing, setSyncing] = useState(false);
  const attention = groups.filter((g) => g.status === "conflict" || g.status === "failed").length;
  const waiting = groups.filter((g) => g.status === "pending" || g.status === "syncing").length;
  const synced = groups.filter((g) => g.status === "synced").length;
  const foreign = s.ops.filter((o) => o.status !== "synced" && !belongsToSession(o)).length;

  async function syncNow() { setSyncing(true); try { await flush(); } finally { setSyncing(false); } }

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Offline queue" description="Sales taken without a connection wait here until they reach the server."
        actions={<Button variant="secondary" iconStart={<RefreshCw />} loading={syncing} onClick={() => void syncNow()} disabled={!s.online}>Sync queue</Button>} />
      {!s.online && <Notice tone="warning" className="mb-4" title="You are offline">Nothing can sync until the connection returns. Your sales are safe on this device.</Notice>}
      {foreign > 0 && <Notice tone="warning" className="mb-4" title="Sales from another account are waiting">{foreign} operation(s) were recorded under a different restaurant account on this device. They will only sync after that account signs in here; they are never sent to this restaurant.</Notice>}
      {attention > 0 && <Notice tone="danger" className="mb-4" title="Some orders need a decision">Review each order below: accept the new prices or discard the sale.</Notice>}
      {groups.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-2 text-xs font-semibold">
          <Badge tone="warning">{waiting} waiting</Badge>
          <Badge tone={attention ? "danger" : "neutral"}>{attention} need review</Badge>
          <Badge tone="success">{synced} synced</Badge>
        </div>
      )}
      {groups.length === 0 ? (
        <Card><EmptyState illustration={<SuccessCheckIllustration title="All synced" />} title="All synced" hint="Nothing queued. Every sale taken on this device has reached the server." /></Card>
      ) : (
        <ul className="space-y-4">{groups.map((g) => <OrderCard key={g.ref} g={g} />)}</ul>
      )}
    </div>
  );
}
