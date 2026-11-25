"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Copy, KeyRound, RefreshCw, Save } from "lucide-react";
import { Badge, Button, Input, Notice, Switch, Table, type BadgeTone } from "@chilli/ui";
import { Card, CardHeader, PillTabs, Skeleton, toast } from "@/components/ui";
import { ApiError } from "@/lib/api";
import { delivery, type DeliveryOrder, type DeliverySettings, type DeliveryStatus } from "@/lib/deliveryApi";
import { formatCurrency } from "@/lib/money";
import { useCan } from "@/lib/useRole";
import { OrderLinkCard, copy } from "./OrderLinkCard";

const OPEN: DeliveryStatus[] = ["placed", "accepted", "preparing", "ready"];
const STATUS: Record<DeliveryStatus, { label: string; tone: BadgeTone }> = {
  placed: { label: "Waiting to accept", tone: "warning" }, accepted: { label: "Accepted", tone: "info" }, preparing: { label: "Preparing", tone: "info" },
  ready: { label: "Ready", tone: "success" }, out_for_delivery: { label: "Out for delivery", tone: "neutral" }, delivered: { label: "Delivered", tone: "neutral" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};
type Filter = "open" | "placed" | "accepted" | "ready";
const rupees = (paise: number) => formatCurrency((paise / 100).toFixed(2), "INR");
const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? (e.status === 0 ? "No connection. Try again when online." : e.message) : fallback);

/**
 * Manage > Delivery (businesses with the delivery_orders capability): take delivery orders on/off, the customer ordering link with
 * its QR code, the delivery-service webhook, and the open delivery orders (accept, confirm a paid-online claim).
 * pos-service: GET/PUT /delivery/settings, GET /delivery/admin/orders, POST .../accept, .../confirm-payment (docs/DELIVERY_API.md).
 */
export function DeliveryTab() {
  const { can } = useCan();
  const [s, setS] = useState<DeliverySettings | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [hook, setHook] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [orders, setOrders] = useState<DeliveryOrder[] | null>(null);
  const [ordersErr, setOrdersErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("open");

  const load = useCallback(async () => {
    try { setS(await delivery.settings()); setErr(null); } catch (e) { setErr(errText(e, "Could not load the delivery settings")); }
  }, []);
  const loadOrders = useCallback(async () => {
    try { setOrders(await delivery.orders()); setOrdersErr(null); } catch (e) { setOrdersErr(errText(e, "Could not load delivery orders")); }
  }, []);
  useEffect(() => {
    void Promise.resolve().then(() => { void load(); void loadOrders(); });
    const id = setInterval(() => { if (document.visibilityState === "visible") void loadOrders(); }, 30_000);
    return () => clearInterval(id);
  }, [load, loadOrders]);

  async function save(what: string, b: Parameters<typeof delivery.saveSettings>[0], done?: string) {
    setBusy(what);
    try {
      accept(await delivery.saveSettings(b));
      if (done) toast.success(done);
      return true;
    } catch (e) { toast.error(errText(e, "Could not save")); return false; } finally { setBusy(null); }
  }
  /** Settings from the link card (also the ones a 502 carries): a signing secret created in that call is shown once, as in save(). */
  function accept(out: DeliverySettings) { setS(out); if (out.webhook_secret) setSecret(out.webhook_secret); }
  async function act(o: DeliveryOrder, kind: "accept" | "pay") {
    setBusy(`${kind}:${o.order_id}`);
    try {
      await (kind === "accept" ? delivery.accept(o.order_id) : delivery.confirmPayment(o.order_id));
      toast.success(kind === "accept" ? `Order ${o.order_code} accepted and sent to the kitchen` : `Payment for ${o.order_code} confirmed`);
      await loadOrders();
    } catch (e) { toast.error(errText(e, "Could not update the order")); } finally { setBusy(null); }
  }

  const shown = (orders ?? []).filter((o) => (filter === "open" ? OPEN.includes(o.status) : filter === "accepted" ? o.status === "accepted" || o.status === "preparing" : o.status === filter));
  const count = (f: Filter) => (orders ?? []).filter((o) => (f === "open" ? OPEN.includes(o.status) : f === "accepted" ? o.status === "accepted" || o.status === "preparing" : o.status === f)).length;
  const hookValue = hook ?? s?.webhook_url ?? "";

  if (err && !s) return <Notice tone="danger" title="Delivery settings" action={<Button size="sm" onClick={() => void load()}>Retry</Button>}>{err}</Notice>;
  if (!s) return <div role="status" aria-label="Loading delivery" className="space-y-4"><Skeleton className="h-36 rounded-2xl" /><Skeleton className="h-56 rounded-2xl" /></div>;

  return (
    <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="space-y-4">
        <Card>
          <CardHeader title="Delivery orders" description="Orders from your ordering link and the delivery service come into Chilli Agent and the kitchen like takeaway." />
          <div className="divide-y divide-border">
            <Switch label="Take delivery orders" hint={s.enabled ? "Customers can order now." : "Off: the ordering link says you are not taking orders."}
              checked={s.enabled} disabled={busy !== null} data-testid="delivery-enabled"
              onChange={(e) => void save("enabled", { enabled: e.target.checked }, e.target.checked ? "Delivery orders are on" : "Delivery orders are off")} />
            <Switch label="Accept each order first" hint="On: a new order waits here until someone accepts it. Off: it goes straight to the kitchen."
              checked={s.accept_before_kot} disabled={busy !== null}
              onChange={(e) => void save("accept", { accept_before_kot: e.target.checked }, "Saved")} />
          </div>
        </Card>

        <OrderLinkCard settings={s} onSettings={accept} onReload={() => void load()} />

        {can("delivery.manage") && (
          <Card>
            <CardHeader title="Delivery service webhook" description="Where order updates (accepted, preparing, ready, cancelled) are sent. Set by support when connecting the delivery service." />
            <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); void save("hook", { webhook_url: hookValue.trim() }, hookValue.trim() ? "Webhook saved" : "Webhook removed").then((ok) => { if (ok) setHook(null); }); }}>
              <div className="min-w-0 flex-1 basis-64"><Input label="Webhook URL" type="url" inputMode="url" autoComplete="off" placeholder="https://" value={hookValue} onChange={(e) => setHook(e.target.value)} hint="Must start with https://" /></div>
              <Button type="submit" iconStart={<Save />} loading={busy === "hook"} disabled={busy !== null || hookValue.trim() === (s.webhook_url ?? "")}>Save</Button>
            </form>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-fg-muted">
              {s.has_webhook_secret ? <Badge tone="success"><Check aria-hidden className="size-3.5" />Signing secret set</Badge> : <Badge>No signing secret yet</Badge>}
              {s.webhook_url && <Button size="sm" variant="ghost" className="min-h-11" iconStart={<KeyRound />} disabled={busy !== null} onClick={() => void save("rotate", { rotate_webhook_secret: true }, "New signing secret created")}>New secret</Button>}
            </div>
            {secret && (
              <Notice tone="warning" className="mt-3" title="Copy the signing secret now">
                <span className="block break-all font-mono text-xs">{secret}</span>
                <span className="mt-2 block">It is shown only once. Give it to support for the delivery service. <Button size="sm" className="ml-1 min-h-11" iconStart={<Copy />} onClick={() => void copy(secret, "Secret")}>Copy</Button></span>
              </Notice>
            )}
          </Card>
        )}
      </div>

      <Card>
        <CardHeader title="Delivery orders now" description="New, accepted and ready orders. Refreshes every 30 seconds."
          action={<Button size="sm" variant="ghost" className="min-h-11" iconStart={<RefreshCw />} onClick={() => void loadOrders()}>Refresh</Button>} />
        <div className="mb-3 max-w-full overflow-x-auto">
          <PillTabs label="Show" value={filter} onChange={(v) => setFilter(v as Filter)} size="sm"
            options={[{ value: "open", label: `All open (${count("open")})` }, { value: "placed", label: `New (${count("placed")})` }, { value: "accepted", label: `Accepted (${count("accepted")})` }, { value: "ready", label: `Ready (${count("ready")})` }]} />
        </div>
        {ordersErr && <Notice tone="danger" className="mb-3">{ordersErr}</Notice>}
        {orders === null ? <Skeleton className="h-40 rounded-xl" /> : shown.length === 0 ? (
          <p className="rounded-xl bg-surface-2 px-4 py-6 text-center text-sm text-fg-muted">{filter === "placed" ? "No order is waiting to be accepted." : "No delivery orders here right now."}</p>
        ) : (
          <Table caption="Delivery orders" rows={shown} getKey={(o) => o.order_id}
            columns={[
              { key: "code", header: "Order", render: (o) => <span className="font-semibold text-fg">{o.order_code}</span> },
              { key: "who", header: "Customer", render: (o) => <span className="block max-w-48 truncate">{o.customer.name ?? o.customer.wa_number ?? "-"}</span> },
              { key: "total", header: "Total", align: "end", render: (o) => <span className="tnum">{rupees(o.total)}</span> },
              { key: "status", header: "Status", render: (o) => <span className="inline-flex flex-wrap gap-1"><Badge tone={STATUS[o.status].tone}>{STATUS[o.status].label}</Badge>{o.claimed_paid && !o.payment_confirmed && <Badge tone="warning">Says paid online</Badge>}</span> },
              { key: "act", header: "Action", align: "end", render: (o) => (
                <span className="inline-flex flex-wrap justify-end gap-1">
                  {o.status === "placed" && can("delivery.accept") && <Button size="sm" className="min-h-11" variant="secondary" loading={busy === `accept:${o.order_id}`} disabled={busy !== null} onClick={() => void act(o, "accept")}>Accept</Button>}
                  {o.claimed_paid && !o.payment_confirmed && can("delivery.accept") && <Button size="sm" className="min-h-11" variant="ghost" loading={busy === `pay:${o.order_id}`} disabled={busy !== null} onClick={() => void act(o, "pay")}>Confirm payment</Button>}
                </span>
              ) },
            ]} />
        )}
      </Card>
    </div>
  );
}
