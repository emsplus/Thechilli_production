"use client";

import { Notice, Skeleton } from "@chilli/ui";
import { useEffect, useMemo, useState } from "react";
import { Card, CardHeader, SegmentedControl } from "@/components/ui";
import { DataGrid } from "./parts";
import { HorizontalBars, num } from "@/components/charts";
import { api, ApiError } from "@/lib/api";
import { formatMoney } from "@/lib/money";
import { PdfButton } from "./PdfButton";
import type { CategorySales, CategorySalesRow } from "@/lib/types";
import { useTaxWord } from "@/lib/taxWords";

type Channel = "all" | "table" | "takeaway" | "online";
const CHANNELS: { value: Channel; label: string }[] = [{ value: "all", label: "All" }, { value: "table", label: "Table" }, { value: "takeaway", label: "Take away" }, { value: "online", label: "Online" }];

/** Sales by category for the reports range (restaurant-local dates), switchable by channel. Bars rank by net sales. */
export function CategorySalesCard({ from, to, tick }: { from: string; to: string; tick: number }) {
  const W = useTaxWord();
  const [data, setData] = useState<CategorySales | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [channel, setChannel] = useState<Channel>("all");

  useEffect(() => {
    let off = false;
    void Promise.resolve().then(async () => {
      setError(null);
      try { const d = await api.salesByCategory(from, to); if (!off) setData(d); }
      catch (e) { if (!off) setError(e instanceof ApiError ? e.message : "Could not load sales by category"); }
    });
    return () => { off = true; };
  }, [from, to, tick]);

  const rows: CategorySalesRow[] = useMemo(() => {
    if (!data) return [];
    if (channel === "all") return data.categories;
    const ch = data.by_channel.find((c) => c.channel === channel || c.channel === (channel === "online" ? "delivery" : channel));
    return ch?.categories ?? [];
  }, [data, channel]);
  const totals = useMemo(() => {
    if (!data) return null;
    if (channel === "all") return data.totals;
    return data.by_channel.find((c) => c.channel === channel)?.totals ?? null;
  }, [data, channel]);
  const vatShown = !!data && (data.categories.some((c) => Number(c.vat) !== 0) );

  return (
    <Card className="mb-5" data-testid="sales-by-category">
      <CardHeader title="Sales by category" description={data ? `Net sales excluding ${W} · ${data.currency}` : `Net sales excluding ${W}`}
        action={<div className="flex items-center gap-2"><div className="hidden sm:block"><SegmentedControl label="Channel" size="md" options={CHANNELS} value={channel} onChange={setChannel} /></div><PdfButton kind="category_sales" from={from} to={to} disabled={!data} /></div>} />
      <div className="mb-4 max-w-full overflow-x-auto sm:hidden"><SegmentedControl label="Channel" block options={CHANNELS} value={channel} onChange={setChannel} /></div>
      {error && <Notice tone="danger">{error}</Notice>}
      {!data && !error && <div role="status" aria-label="Loading sales by category"><Skeleton className="h-48 rounded-xl" /></div>}
      {data && rows.length === 0 && <p className="py-4 text-sm text-fg-muted">No sales in this channel for this range.</p>}
      {data && rows.length > 0 && (
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <HorizontalBars ariaLabel="Sales by category, net" data={[...rows].sort((a, b) => num(b.net) - num(a.net)).map((c) => ({
            key: c.category, label: c.category, value: num(c.net), sub: `${c.quantity} sold · ${Number(c.share_percent)}%`, valueText: formatMoney(c.net) }))} />
          <DataGrid caption="Sales by category table" getKey={(c) => c.category} rows={rows} total={totals ? { category: "Total", quantity: totals.quantity, net: totals.net, vat: totals.vat, gross: totals.gross, share_percent: "" } as (typeof rows)[number] : undefined}
            cols={[
              { header: "Category", render: (c) => c.category },
              { header: "Qty", end: true, render: (c) => c.quantity },
              { header: "Net", end: true, render: (c) => formatMoney(c.net) },
              ...(vatShown ? [{ header: `${W}`, end: true, render: (c: (typeof rows)[number]) => formatMoney(c.vat) }] : []),
              { header: "Gross", end: true, render: (c) => formatMoney(c.gross) },
              { header: "Share", end: true, render: (c) => (c.share_percent === "" ? "" : `${Number(c.share_percent)}%`) },
            ]} />
        </div>
      )}
      {data && channel === "all" && Number(data.totals.service_charge) > 0 && <p className="mt-3 text-xs text-fg-subtle">Service charge of {formatMoney(data.totals.service_charge)} is not part of any category.</p>}
    </Card>
  );
}
