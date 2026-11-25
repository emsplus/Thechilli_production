"use client";

import { formatDate } from "@/lib/datetime";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Button, ErrorState, Notice, Skeleton, SkeletonGroup } from "@chilli/ui";
import { ApiError } from "@/lib/api";
import { useLocale } from "@/lib/i18n";
import { isMissing, type StockItem, type StockLocation } from "@/lib/inventoryApi";
import { uuid } from "@/lib/uuid";
import type { Supplier } from "@/lib/types";
import { INV_MSG } from "./messages";
import { useMsg } from "@/lib/i18n";

export const errText = (e: unknown, fb: string) => (e instanceof ApiError ? e.message : fb);

export type Load<T> = { status: "loading" } | { status: "ready"; data: T } | { status: "error"; message: string } | { status: "missing" };

/** Loads one section's data. 404/405/501 -> "missing" (the section hides); anything else -> "error" with a retry. */
export function useSection<T>(fetcher: () => Promise<T>, deps: readonly unknown[] = []): { state: Load<T>; reload: () => Promise<void> } {
  const [state, setState] = useState<Load<T>>({ status: "loading" });
  const seq = useRef(0);
  // The caller names the dependencies that should refetch (like useEffect deps), so the list is not a literal here.
  // eslint-disable-next-line react-hooks/exhaustive-deps, react-hooks/use-memo
  const run = useCallback(fetcher, deps);
  const reload = useCallback(async () => {
    const mine = ++seq.current;
    try { const data = await run(); if (mine === seq.current) setState({ status: "ready", data }); }
    catch (e) { if (mine === seq.current) setState(isMissing(e) ? { status: "missing" } : { status: "error", message: errText(e, "Could not load") }); }
  }, [run]);
  useEffect(() => { void Promise.resolve().then(reload); }, [reload]);
  return { state, reload };
}

/** Skeleton while loading, a danger notice with Retry on error, nothing when the endpoint is missing. */
export function Gate<T>({ state, reload, children, rows = 4 }: { state: Load<T>; reload: () => void; children: (data: T) => ReactNode; rows?: number }) {
  const { locale } = useLocale();
  const t = useMsg(INV_MSG);
  if (state.status === "loading") return <SkeletonGroup locale={locale}><div className="space-y-2">{Array.from({ length: rows }, (_, i) => <Skeleton key={i} height={44} />)}</div></SkeletonGroup>;
  if (state.status === "missing") return null;
  if (state.status === "error") return <ErrorState title={t("loadFail")} description={state.message} actionLabel={t("retry")} onAction={reload} locale={locale} />;
  return <>{children(state.data)}</>;
}

export function ErrorNotice({ message, onRetry }: { message: string | null; onRetry?: () => void }) {
  const t = useMsg(INV_MSG);
  if (!message) return null;
  return <Notice tone="danger" action={onRetry ? <Button size="sm" onClick={onRetry}>{t("retry")}</Button> : undefined}>{message}</Notice>;
}

/** Items, suppliers and locations the forms pick from, loaded once for the whole page. */
export interface Refs { items: StockItem[]; suppliers: Supplier[]; locations: StockLocation[]; itemName: (id: string) => string; itemById: (id: string) => StockItem | undefined; supplierName: (id: string) => string; locationName: (id: string) => string; reloadLocations: () => void }
const RefsCtx = createContext<Refs | null>(null);
export const RefsProvider = RefsCtx.Provider;
export function useRefs(): Refs {
  const r = useContext(RefsCtx);
  if (!r) throw new Error("RefsProvider missing");
  return r;
}

/** One idempotency key per attempt: reused when the same submit is retried, renewed after it succeeded. */
export function useIdempotencyKey() {
  const k = useRef(uuid());
  return { get: () => k.current, renew: () => { k.current = uuid(); } };
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return formatDate(`${m[1]}-${m[2]}-${m[3]}`);
}
