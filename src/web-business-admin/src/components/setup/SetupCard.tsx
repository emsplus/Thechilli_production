"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, CheckCircle2, Circle, MinusCircle, X } from "lucide-react";
import { Button, IconButton } from "@chilli/ui";
import { Card } from "@/components/ui";
import { ApiError, auth } from "@/lib/api";
import { extras, type SetupStatus, type SetupStepId } from "@/lib/extras";
import { cn } from "@/lib/cn";
import { useCan } from "@/lib/useRole";

/** Where each step is done. */
export const STEP_LINK: Record<SetupStepId, string> = {
  business: "/manage?tab=restaurant", outlet: "/manage?tab=outlets", tables: "/manage?tab=tables", menu: "/manage?tab=menu",
  printer: "/manage?tab=printers", tax: "/manage?tab=restaurant", staff: "/manage?tab=staff", upi: "/manage?tab=restaurant#upi",
  delivery: "/manage?tab=delivery", // "Turn on delivery": cloud / hotel kitchens with the delivery module
};
const hideKey = () => `pos.setupHidden.${auth.restaurantId ?? "-"}`;

/**
 * "Get set up" card on Manage > Overview for a new restaurant: the 8 steps of GET /setup/status with progress, a link to the right
 * settings page per step, Skip / Undo skip, and a close button (remembered on this device). Gone once every step is done
 * or skipped. Owners / managers only (setup.manage); servers without the route simply show nothing.
 */
export function SetupCard() {
  const { can, ready } = useCan();
  const allowed = ready && can("setup.manage");
  const [s, setS] = useState<SetupStatus | null>(null);
  const [hidden, setHidden] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (!allowed) return;
    let h = false;
    try { h = localStorage.getItem(hideKey()) === "1"; } catch { /* storage unavailable */ }
    void Promise.resolve().then(() => setHidden(h));
    if (h) return;
    extras.setupStatus().then(setS).catch((e) => { if (!(e instanceof ApiError)) return; setS(null); });
  }, [allowed]);

  if (!allowed || hidden || !s || s.complete) return null;
  const dismiss = () => { try { localStorage.setItem(hideKey(), "1"); } catch { /* ignore */ } setHidden(true); };
  async function skip(id: SetupStepId, on: boolean) {
    setBusy(id);
    try { setS(on ? await extras.skipStep(id) : await extras.unskipStep(id)); } catch { /* keep the list */ } finally { setBusy(null); }
  }
  const next = s.steps.find((x) => x.status === "todo");
  return (
    <Card className="mb-4" data-testid="setup-card">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-display text-lg font-bold text-fg">Finish setting up</h2>
          <p className="text-sm text-fg-muted">{s.done + s.skipped} of {s.total} done{next ? `. Next: ${next.title}` : ""}</p>
        </div>
        <IconButton label="Hide setup checklist" icon={<X />} onClick={dismiss} />
      </div>
      <div className="my-3 h-2 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-label="Setup progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={s.percent}>
        <div className="h-full rounded-full bg-primary-gradient transition-[width]" style={{ width: `${s.percent}%` }} />
      </div>
      <ul className="grid gap-1 sm:grid-cols-2">
        {s.steps.map((st) => (
          <li key={st.id} className="flex min-h-12 items-center gap-2 rounded-xl px-2 hover:bg-surface-2" data-testid={`setup-step-${st.id}`}>
            {st.status === "done" ? <CheckCircle2 aria-hidden className="size-5 shrink-0 text-success" /> : st.status === "skipped" ? <MinusCircle aria-hidden className="size-5 shrink-0 text-fg-subtle" /> : <Circle aria-hidden className="size-5 shrink-0 text-border-strong" />}
            <Link href={STEP_LINK[st.id] ?? "/manage"} className={cn("flex min-h-11 min-w-0 flex-1 items-center gap-1 text-sm font-semibold", st.status === "todo" ? "text-fg" : "text-fg-muted")}>
              <span className="truncate">{st.title}</span><span className="sr-only"> ({st.status === "todo" ? "to do" : st.status})</span>
              {st.status === "todo" && <ArrowRight aria-hidden className="size-4 shrink-0 text-fg-subtle" />}
            </Link>
            {st.status === "todo" && <Button size="sm" variant="ghost" disabled={busy === st.id} onClick={() => void skip(st.id, true)} aria-label={`Skip ${st.title}`}>Skip</Button>}
            {st.status === "skipped" && <Button size="sm" variant="ghost" disabled={busy === st.id} onClick={() => void skip(st.id, false)} aria-label={`Undo skip ${st.title}`}>Undo</Button>}
          </li>
        ))}
      </ul>
    </Card>
  );
}
