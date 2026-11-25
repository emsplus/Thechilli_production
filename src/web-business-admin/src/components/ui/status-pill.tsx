import { AlertTriangle, ChefHat, CheckCheck, CircleCheck, CircleDot, CircleX, Clock, CloudOff, FileClock, GitMerge, HandPlatter, Loader, PackageX, TrendingDown, Ban } from "lucide-react";
import type { ReactNode } from "react";
import { Badge, type BadgeTone } from "@chilli/ui";

/**
 * One place that maps domain states to colour + icon + label, so a state looks identical on
 * every page and is never conveyed by colour alone (icon + text always shown).
 */
type Def = { tone: BadgeTone; label: string; icon: ReactNode };
const i = "size-3.5";

const MAP = {
  order: {
    open: { tone: "info", label: "Open", icon: <CircleDot className={i} /> },
    placed: { tone: "info", label: "Placed", icon: <CircleDot className={i} /> },
    finalized: { tone: "warning", label: "Awaiting payment", icon: <Clock className={i} /> },
    paid: { tone: "success", label: "Paid", icon: <CircleCheck className={i} /> },
    void: { tone: "danger", label: "Void", icon: <Ban className={i} /> },
    sent_to_kitchen: { tone: "info", label: "In kitchen", icon: <ChefHat className={i} /> },
    billed: { tone: "warning", label: "Billed", icon: <Clock className={i} /> },
    cancelled: { tone: "danger", label: "Cancelled", icon: <CircleX className={i} /> },
    merged: { tone: "neutral", label: "Merged", icon: <GitMerge className={i} /> },
  },
  kot: {
    new: { tone: "info", label: "New", icon: <CircleDot className={i} /> },
    pending: { tone: "info", label: "New", icon: <CircleDot className={i} /> },
    queued: { tone: "warning", label: "Queued offline", icon: <CloudOff className={i} /> },
    preparing: { tone: "warning", label: "Preparing", icon: <ChefHat className={i} /> },
    ready: { tone: "success", label: "Ready", icon: <HandPlatter className={i} /> },
    served: { tone: "neutral", label: "Served", icon: <CheckCheck className={i} /> },
    cancelled: { tone: "danger", label: "Cancelled", icon: <CircleX className={i} /> },
  },
  stock: {
    ok: { tone: "success", label: "In stock", icon: <CircleCheck className={i} /> },
    low: { tone: "warning", label: "Low stock", icon: <TrendingDown className={i} /> },
    out: { tone: "danger", label: "Out of stock", icon: <PackageX className={i} /> },
  },
  sync: {
    pending: { tone: "warning", label: "Pending", icon: <Clock className={i} /> },
    syncing: { tone: "info", label: "Syncing", icon: <Loader className={`${i} animate-spin`} /> },
    synced: { tone: "success", label: "Synced", icon: <CircleCheck className={i} /> },
    failed: { tone: "danger", label: "Failed", icon: <CircleX className={i} /> },
    conflict: { tone: "danger", label: "Needs review", icon: <GitMerge className={i} /> },
    offline: { tone: "neutral", label: "Offline", icon: <CloudOff className={i} /> },
  },
  purchase: {
    uploaded: { tone: "info", label: "Uploaded", icon: <FileClock className={i} /> },
    extracted: { tone: "warning", label: "Needs review", icon: <AlertTriangle className={i} /> },
    failed: { tone: "danger", label: "Failed", icon: <CircleX className={i} /> },
    confirmed: { tone: "success", label: "Confirmed", icon: <CircleCheck className={i} /> },
  },
} satisfies Record<string, Record<string, Def>>;

export type StatusKind = keyof typeof MAP;

export function StatusPill({ kind, status, label }: { kind: StatusKind; status: string; label?: string; /** Kept for call sites; the design-system badge has one size. */ size?: "sm" | "md" }) {
  const def = (MAP[kind] as Record<string, Def>)[status];
  return (
    <Badge tone={def?.tone ?? "neutral"}>
      {def?.icon}{label ?? def?.label ?? status}
    </Badge>
  );
}
