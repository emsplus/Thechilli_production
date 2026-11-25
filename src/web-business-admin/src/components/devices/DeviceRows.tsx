"use client";

import { Laptop, Monitor, Smartphone, Tablet } from "lucide-react";
import { Badge, Button } from "@chilli/ui";
import { Card, Skeleton } from "@/components/ui";
import { deviceTitle, lastSeenText, platformLabel, type SignedInDevice } from "@/lib/devices";

function PlatformIcon({ d }: { d: SignedInDevice }) {
  const p = (d.platform ?? "").toLowerCase();
  const ua = d.user_agent ?? "";
  const Icon = p === "android" || p === "ios" || /Mobile|Android|iPhone/.test(ua) ? Smartphone : /iPad|Tablet/.test(ua) ? Tablet : p === "windows" ? Monitor : Laptop;
  return <span className="grid size-10 shrink-0 place-items-center rounded-full bg-surface-2 text-fg-muted"><Icon aria-hidden className="size-5" /></span>;
}

/**
 * Signed-in devices as a list that reads well from 360 px up: name + badges, then platform / last seen / IP, then the action.
 * `showPerson`: the "All staff devices" view (whose device it is). `canRevoke(d)` hides the button where the API would refuse.
 */
export function DeviceRows({ rows, loading, showPerson, canRevoke, onRevoke, busyId, testId }: {
  rows: SignedInDevice[]; loading: boolean; showPerson?: boolean; canRevoke: (d: SignedInDevice) => boolean; onRevoke: (d: SignedInDevice) => void; busyId?: string | null; testId?: string;
}) {
  if (loading) return <div role="status" aria-label="Loading devices" className="space-y-2">{[0, 1].map((i) => <Skeleton key={i} className="h-20 rounded-xl" />)}</div>;
  if (!rows.length) return <Card><p className="py-4 text-center text-sm text-fg-muted">No signed-in devices.</p></Card>;
  return (
    <Card padded={false}>
      <ul className="divide-y divide-border" data-testid={testId}>
        {rows.map((d) => {
          const title = deviceTitle(d);
          return (
            <li key={d.id} data-testid="device-row" className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
              <PlatformIcon d={d} />
              <div className="min-w-0 flex-1 basis-48">
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-semibold text-fg">
                  <span className="min-w-0 break-words">{title}</span>
                  {d.current && <Badge tone="primary" data-testid="current-device">This device</Badge>}
                  {!d.active && <Badge tone="neutral">Signed out</Badge>}
                </p>
                {showPerson && <p className="text-sm text-fg">{d.user_name || "Unnamed"}{d.user_role ? <span className="text-fg-muted"> · <span className="capitalize">{d.user_role}</span></span> : null}</p>}
                <p className="text-xs text-fg-muted">
                  {platformLabel(d.platform)}{d.model && d.model !== title ? ` · ${d.model}` : ""} · Last seen <time dateTime={d.last_seen_at ?? undefined} title={d.last_seen_at ? new Date(d.last_seen_at).toLocaleString("en-IN") : undefined}>{lastSeenText(d.last_seen_at).toLowerCase()}</time>
                  {d.last_ip ? <> · IP <span className="tnum">{d.last_ip}</span></> : null}
                </p>
              </div>
              {d.active && canRevoke(d) && (
                <Button size="sm" variant="danger-soft" loading={busyId === d.id} aria-label={`${d.current ? "Sign out" : "Revoke"} ${title}${showPerson && d.user_name ? ` of ${d.user_name}` : ""}`} onClick={() => onRevoke(d)}>
                  {d.current ? "Sign out" : "Revoke"}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
