"use client";

import { Badge, Button, Notice, PageHeader, Skeleton } from "@chilli/ui";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { BellRing, MessageCircleOff, RefreshCw, Star } from "lucide-react";
import { Card, EmptyState, StatusPill, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui";
import { StockBoxIllustration, SuccessCheckIllustration } from "@/components/illustrations";
import { api } from "@/lib/api";
import { formatDateTime, relativeTime } from "@/lib/datetime";
import { prettyQty } from "@/lib/units";
import { useLoader } from "@/lib/useLoader";
import { useMsg } from "@/lib/i18n";
import { useLowReviews } from "@/lib/useOpenAlerts";
import { QR_MSG } from "@/app/manage/_components/qr-messages";
import type { Alert, InventoryItem } from "@/lib/types";

const fetchAll = async () => {
  const [alerts, items] = await Promise.all([api.alerts(), api.inventoryItems()]);
  return { alerts, items };
};

export default function AlertsPage() {
  const { data, error, loading, reload } = useLoader(fetchAll);
  const [now, setNow] = useState(0);
  useEffect(() => { const t = () => setNow(Date.now()); t(); const i = setInterval(t, 60000); return () => clearInterval(i); }, []);
  const items = useMemo(() => new Map((data?.items ?? []).map((i) => [i.id, i])), [data]);
  const open = data?.alerts.filter((a) => a.status === "open") ?? [];
  const resolved = data?.alerts.filter((a) => a.status !== "open") ?? [];

  return (
    <>
      <PageHeader title="Alerts" description="Low-stock notifications, newest first. They resolve themselves once stock recovers."
        actions={<Button variant="secondary" size="sm" iconStart={<RefreshCw />} onClick={() => void reload()}>Refresh</Button>} />
      {error && <Notice tone="danger" className="mb-4" action={<Button size="sm" variant="secondary" onClick={() => void reload()}>Retry</Button>}>{error}</Notice>}
      <LowRatings />
      <Notice tone="info" className="mb-5"><span className="flex items-center gap-2"><MessageCircleOff className="size-4 shrink-0" aria-hidden />Alerts show in the app only. WhatsApp delivery is not enabled yet.</span></Notice>

      {loading ? (
        <div className="space-y-3" role="status" aria-label="Loading alerts">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-24 w-full rounded-xl" />)}</div>
      ) : (
        <Tabs defaultValue="open">
          <TabsList>
            <TabsTrigger value="open">Open{open.length > 0 && <Badge tone="danger">{open.length}</Badge>}</TabsTrigger>
            <TabsTrigger value="resolved">Resolved<span className="tnum text-xs text-fg-subtle">{resolved.length}</span></TabsTrigger>
          </TabsList>
          <TabsContent value="open">
            {open.length === 0 ? (
              <Card><EmptyState illustration={<SuccessCheckIllustration />} title="Everything is stocked" hint={data?.alerts.length ? "No open alerts. Nice work." : "Set reorder levels on inventory items to be warned before you run out."}
                action={!data?.alerts.length && <Link href="/manage?tab=inventory" className="ch-btn ch-btn--secondary ch-btn--md">Go to Inventory</Link>} /></Card>
            ) : <AlertList list={open} items={items} now={now} />}
          </TabsContent>
          <TabsContent value="resolved">
            {resolved.length === 0 ? <Card><EmptyState illustration={<StockBoxIllustration />} title="Nothing resolved yet" hint="Resolved alerts are kept here as history." /></Card> : <AlertList list={resolved} items={items} now={now} />}
          </TabsContent>
        </Tabs>
      )}
    </>
  );
}

function AlertList({ list, items, now }: { list: Alert[]; items: Map<string, InventoryItem>; now: number }) {
  return (
    <ol className="relative space-y-3 before:absolute before:bottom-4 before:left-[1.35rem] before:top-4 before:w-px before:bg-border sm:before:left-[1.6rem]">
      {list.map((a) => {
        const it = items.get(a.item_id); const isOpen = a.status === "open";
        return (
          <li key={a.id} className="relative flex gap-3 sm:gap-4">
            <span className={`z-10 mt-4 grid size-11 shrink-0 place-items-center rounded-full border-4 border-bg ${isOpen ? "bg-warning-soft text-warning-fg" : "bg-success-soft text-success-fg"}`}><BellRing className="size-4" aria-hidden /></span>
            <Card className="min-w-0 flex-1">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold text-fg">{it?.name ?? "Inventory item"}</p>
                  <p className="text-sm text-fg-muted">{a.message}</p>
                </div>
                <StatusPill kind="stock" status={isOpen ? "low" : "ok"} label={isOpen ? "Open" : "Resolved"} />
              </div>
              <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm">
                <div><dt className="inline text-fg-subtle">Balance at alert </dt><dd className="tnum inline font-semibold">{prettyQty(a.balance, it?.base_unit ?? "")}</dd></div>
                {it && <div><dt className="inline text-fg-subtle">Reorder at </dt><dd className="tnum inline font-semibold">{prettyQty(it.reorder_level, it.base_unit)}</dd></div>}
                {it && isOpen && Number(it.balance) !== Number(a.balance) && <div><dt className="inline text-fg-subtle">Now </dt><dd className="tnum inline font-semibold">{prettyQty(it.balance, it.base_unit)}</dd></div>}
              </dl>
              <p className="mt-2 text-xs text-fg-subtle">
                <time dateTime={a.created_at} title={formatDateTime(a.created_at)}>Raised {relativeTime(a.created_at, now)}</time>
                {a.resolved_at && <> · <time dateTime={a.resolved_at} title={formatDateTime(a.resolved_at)}>resolved {relativeTime(a.resolved_at, now)}</time></>}
              </p>
            </Card>
          </li>
        );
      })}
    </ol>
  );
}

/** Unread 1-2 star guest reviews from the table review QR codes (owners / managers): a link to Manage > Reviews. */
function LowRatings() {
  const n = useLowReviews();
  const tr = useMsg(QR_MSG);
  if (!n) return null;
  return (
    <Card className="mb-4 border-danger/40" data-testid="low-ratings-alert">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="grid size-11 shrink-0 place-items-center rounded-full bg-danger-soft text-danger-fg"><Star className="size-4" aria-hidden /></span>
          <div><p className="font-semibold text-fg">{n === 1 ? tr("lowAlertOne") : tr("lowAlertTitle", { n })}</p><p className="text-sm text-fg-muted">{tr("lowAlertBody")}</p></div>
        </div>
        <Link href="/manage?tab=reviews" className="ch-btn ch-btn--secondary ch-btn--md">{tr("openReviews")}</Link>
      </div>
    </Card>
  );
}
