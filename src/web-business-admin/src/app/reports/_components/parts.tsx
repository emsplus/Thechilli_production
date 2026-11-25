"use client";

import type { ReactNode } from "react";
import { Notice, Skeleton, StatCard, Table, type Column, type Locale } from "@chilli/ui";
import { cn } from "@/lib/cn";

/** KPI tile: the design-system StatCard with an optional caption underneath (hints, footnotes). `value` is already formatted. */
export function KpiTile({ label, value, hint, loading, className, locale }: { label: string; value: ReactNode; hint?: ReactNode; loading?: boolean; className?: string; locale?: Locale }) {
  return (
    // The hint lives inside the card (design-system StatCard `hint`), not floating under it.
    <div className={cn("flex min-w-0 flex-col [&>.ch-stat]:h-full", className)}>
      <StatCard label={label} value={value} loading={loading} locale={locale} hint={hint} />
    </div>
  );
}

export interface Col<T> { header: string; render: (r: T) => ReactNode; end?: boolean }

/** Design-system Table with a totals row. `rows` + `total` share the same columns; the total row is bold. */
export function DataGrid<T>({ caption, cols, rows, getKey, total, empty, className }: {
  caption: string; cols: Col<T>[]; rows: T[]; getKey: (r: T) => string; total?: T; empty?: ReactNode; className?: string;
}) {
  type Row = { row: T; isTotal: boolean };
  const all: Row[] = [...rows.map((row) => ({ row, isTotal: false })), ...(total ? [{ row: total, isTotal: true }] : [])];
  const columns: Column<Row>[] = cols.map((c, i) => ({
    key: `c${i}`, header: c.header, align: c.end ? "end" : undefined,
    render: (r) => (r.isTotal ? <strong>{c.render(r.row)}</strong> : c.render(r.row)),
  }));
  return <div className={className}><Table caption={caption} columns={columns} rows={all} getKey={(r) => (r.isTotal ? "__total" : getKey(r.row))} empty={empty} /></div>;
}

/** Loading placeholder for a block (announced once). */
export function BlockSkeleton({ label, rows = 3 }: { label: string; rows?: number }) {
  return (
    <div role="status" aria-label={label} className="space-y-2">
      {Array.from({ length: rows }, (_, i) => <Skeleton key={i} height={20} className="w-full" />)}
    </div>
  );
}

/** A Notice with spacing (the design-system Notice has no className). */
export function Gap({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("mb-4", className)}>{children}</div>;
}

export { Notice };
