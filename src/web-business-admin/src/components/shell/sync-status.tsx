"use client";

import { Button } from "@chilli/ui";
import Link from "next/link";
import { CloudOff, RefreshCw, TriangleAlert } from "lucide-react";
import { useSyncStatus } from "@/lib/useSyncStatus";
import { flush } from "@/lib/sync";
import { cn } from "@/lib/cn";

/**
 * Connection + offline-queue status. Rendered exactly once (top bar). Keeps the test hooks
 * data-testid = sync-status | conn | pending-count used by the e2e suite.
 */
export function SyncStatus() {
  const s = useSyncStatus();
  const waiting = s.pending + s.syncing;
  const attention = s.failed + s.conflict;
  const pill = "inline-flex h-11 pointer-fine:h-9 items-center gap-2 rounded-full px-3 ring-1 ring-inset";
  return (
    <div className="flex items-center gap-1.5 text-xs font-semibold" data-testid="sync-status">
      <span className={cn(pill, s.online ? "bg-success-soft text-success-fg ring-success/20 max-[399px]:w-7 max-[399px]:justify-center max-[399px]:px-0" : "bg-warning-soft text-warning-fg ring-warning/30")}>
        {s.online
          ? <span aria-hidden className="anim-pulse-dot size-2 rounded-full bg-success text-success" />
          : <CloudOff aria-hidden className="size-3.5" />}
        <span data-testid="conn" role="status" className={s.online ? "max-[399px]:sr-only" : undefined}>{s.online ? "Online" : "Offline"}</span>
      </span>
      {waiting > 0 && (
        <span data-testid="pending-count" className={cn(pill, "bg-warning-soft text-warning-fg ring-warning/30")}>{waiting} pending</span>
      )}
      {attention > 0 && (
        <Link href="/sync" className={cn(pill, "gap-1.5 bg-danger-soft text-danger-fg ring-danger/25 hover:brightness-95")}>
          <TriangleAlert aria-hidden className="size-3.5" />{attention} need attention
        </Link>
      )}
      {waiting > 0 && s.online && (
        <Button variant="ghost" size="sm" onClick={() => void flush()} iconStart={<RefreshCw aria-hidden className="size-3.5" />}>Sync now</Button>
      )}
    </div>
  );
}
