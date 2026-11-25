"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Notice } from "@chilli/ui";
import { formatDateTime } from "@/lib/datetime";
import { hoursOpen, shiftTooLong } from "@/lib/cashFloat";
import { useCashSession } from "@/lib/cashSession";
import { useTaxConfig } from "@/lib/taxConfig";
import { useCan } from "@/lib/useRole";

/**
 * A cash drawer shift left open for more than 24 hours: a prominent banner on the counter, the Cash drawer and End of day.
 * Hours come from the server's `opened_at` instant; the restaurant's timezone only decides how the start time is written.
 * `hideLink`: on the Cash drawer itself the Close shift button is right below.
 */
export function ShiftOpenBanner({ hideLink }: { hideLink?: boolean }) {
  const { can, ready } = useCan();
  const cfg = useTaxConfig();
  const q = useCashSession(ready && can("cashier.shift"));
  const [now, setNow] = useState(0);
  useEffect(() => { const t = () => setNow(Date.now()); t(); const i = setInterval(t, 60_000); return () => clearInterval(i); }, []);
  const s = q.data;
  if (!now || !s || s === "unsupported" || s.status !== "open" || !shiftTooLong(s.opened_at, now)) return null;
  const hours = hoursOpen(s.opened_at, now);
  return (
    <div data-testid="shift-stale-banner" role="alert" className="shrink-0">
      <Notice tone="warning" title={`This shift has been open for ${hours} hours`}
        action={hideLink ? undefined : <Link href="/cash" className="ch-btn ch-btn--primary ch-btn--sm">Close shift</Link>}>
        This shift has been open for {hours} hours. Close it before starting a new day. It opened {formatDateTime(s.opened_at, cfg?.timezone || undefined)}.
      </Notice>
    </div>
  );
}
