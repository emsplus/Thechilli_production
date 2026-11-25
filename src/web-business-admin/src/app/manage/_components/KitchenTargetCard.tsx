"use client";

import { useState } from "react";
import { ChefHat } from "lucide-react";
import { Button, Input } from "@chilli/ui";
import { Card, CardHeader, toast } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { refreshRestaurantMeta } from "@/lib/restaurantMeta";
import { setKitchenTarget, TARGET_MAX, TARGET_MIN, useKitchenTarget } from "@/lib/kitchenTarget";
import { formatWait } from "@/lib/ticketAge";

/**
 * Kitchen ticket target (the "15 minutes" every lateness colour is measured against). pos-service stores it per restaurant
 * (PUT /restaurant `kitchen_target_minutes`, owner only; GET /restaurant and /auth/me return it and the server value wins on this
 * device), so Save writes it there and keeps a copy on this device for offline starts. Lives inside the Restaurant form, so Enter
 * saves this card, not the form.
 */
export function KitchenTargetCard() {
  const target = useKitchenTarget();
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? String(target);
  const n = Number(value);
  const valid = /^\d{1,2}$/.test(value.trim()) && n >= TARGET_MIN && n <= TARGET_MAX;
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!valid || saving) return;
    setSaving(true);
    try {
      // PUT /restaurant replaces name / GSTIN / address, so the current profile goes along unchanged.
      const r = await api.restaurant();
      await api.updateRestaurant({ name: r.name, trn: r.trn, address: r.address ?? null, kitchen_target_minutes: n });
      setKitchenTarget(n); setDraft(null); refreshRestaurantMeta();
      toast.success(`Kitchen target set to ${formatWait(n)}`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not save the kitchen target. Check your connection and try again.");
    } finally { setSaving(false); }
  };
  return (
    <Card>
      <CardHeader title="Kitchen target" description="How long a ticket may wait before it shows as getting late. Twice this time shows as late." />
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-40">
          <Input label="Target (minutes)" inputMode="numeric" value={value} data-testid="kitchen-target"
            error={valid ? undefined : `Enter ${TARGET_MIN} to ${TARGET_MAX} minutes`}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void save(); } }} />
        </div>
        <Button type="button" iconStart={<ChefHat />} loading={saving} disabled={!valid || n === target} onClick={() => void save()}>Save target</Button>
      </div>
      <p className="mt-3 text-sm text-fg-muted">
        Getting late from <span className="font-semibold text-fg">{formatWait(target)}</span>, late from <span className="font-semibold text-fg">{formatWait(2 * target)}</span>.
        Used by the kitchen screen, Chilli Agent and the Manage overview.
      </p>
    </Card>
  );
}
