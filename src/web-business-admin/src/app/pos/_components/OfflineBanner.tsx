import { formatDateTime } from "@/lib/datetime";
import { OfflineCloudIllustration } from "@/components/illustrations";

/** Persistent offline state: stale-menu notice (testid kept for e2e) or a plain "you are offline" note. */
export function OfflineBanner({ online, staleSince }: { online: boolean; staleSince: string | null }) {
  if (online && !staleSince) return null;
  return (
    <div role="status" data-testid={staleSince ? "stale-banner" : undefined} className="flex items-center gap-3 rounded-xl bg-warning-soft p-3 text-sm text-warning-fg">
      <div className="hidden w-14 shrink-0 sm:block"><OfflineCloudIllustration /></div>
      <div>
        {staleSince
          ? <p><b>Offline</b> — showing the menu saved {formatDateTime(staleSince)}. Prices are confirmed when you reconnect.</p>
          : <p><b>You are offline.</b> Orders and payments are saved on this device and sync automatically when the connection returns.</p>}
      </div>
    </div>
  );
}
