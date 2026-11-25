"use client";

import { useState } from "react";
import { Badge, Notice, Switch } from "@chilli/ui";
import { Card, CardHeader, Skeleton, toast } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { refreshCapabilities } from "@/lib/useRole";
import { useLoader } from "@/lib/useLoader";
import type { FeatureAccess } from "@/lib/types";

const fetchFeatures = () => api.features();
const GROUPS: readonly { id: FeatureAccess["group"]; title: string; hint: string }[] = [
  { id: "order_types", title: "Order types", hint: "Which kinds of orders you take. At least one must stay on." },
  { id: "billing", title: "Billing", hint: "What the bill screen may do." },
  { id: "modules", title: "Modules", hint: "Back-office screens. End of day always stays." },
];

/**
 * Manage > Features (owner only). Super admin decides what is available to this restaurant (its plan, or a per-restaurant override);
 * the owner then switches what it wants to use on or off. A feature that is not in the plan shows "Not in your plan" and cannot be
 * switched on here. Switching one off hides it from the screens and the server refuses it (pos-service feature access).
 */
export function FeaturesTab() {
  const { data, error, loading, reload } = useLoader(fetchFeatures);
  const [rows, setRows] = useState<FeatureAccess[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const list = rows ?? data;

  const toggle = async (f: FeatureAccess, on: boolean) => {
    if (busy) return;
    setBusy(f.code);
    try {
      setRows(await api.setFeatures({ [f.code]: on }));
      refreshCapabilities(); // menus, the POS and the nav pick the change up now
      toast.success(`${f.label} ${on ? "is on" : "is off"}`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not save");
      void reload();
    } finally { setBusy(null); }
  };

  if (error && !list) return <Notice tone="danger" title="Could not load features">{error}</Notice>;
  if (loading && !list) return <div className="space-y-4"><Skeleton className="h-28 rounded-2xl" /><Skeleton className="h-40 rounded-2xl" /></div>;
  if (!list) return null;

  return (
    <div className="space-y-4" data-testid="features-tab">
      <Notice tone="info" title="What you can use">
        Your plan decides what is available. Switch off what you do not use, and it disappears from the screens. Something marked
        &ldquo;Not in your plan&rdquo; can be added by support.
      </Notice>
      {GROUPS.map((g) => {
        const items = list.filter((f) => f.group === g.id);
        if (!items.length) return null;
        return (
          <Card key={g.id}>
            <CardHeader title={g.title} description={g.hint} />
            <ul className="divide-y divide-border">
              {items.map((f) => (
                <li key={f.code} className="flex items-start justify-between gap-3 py-3 first:pt-0 last:pb-0" data-testid={`feature-${f.code}`}>
                  <div className="min-w-0 flex-1">
                    <Switch label={f.label} hint={f.description} checked={f.granted && f.switched_on} disabled={!f.granted || busy !== null}
                      onChange={(e) => void toggle(f, e.target.checked)} />
                  </div>
                  {!f.granted && <Badge tone="warning">Not in your plan</Badge>}
                </li>
              ))}
            </ul>
          </Card>
        );
      })}
    </div>
  );
}
