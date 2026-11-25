"use client";

import { useState } from "react";
import { ChefHat } from "lucide-react";
import { Button, Input } from "@chilli/ui";
import { Card, CardHeader, toast } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { useMsg } from "@/lib/i18n";
import { KITCHEN_STATUS_MSG } from "./kitchen-status-messages";
import { refreshRestaurantMeta } from "@/lib/restaurantMeta";
import { DISPLAY_MAX, DISPLAY_MIN, setKitchenDisplayMinutes, setKitchenMode, useKitchenDisplayMinutes, useKitchenMode, type KitchenStatusMode } from "@/lib/kitchenStatusMode";
import { cn } from "@/lib/cn";

/**
 * Manage > Restaurant: "Kitchen status tracking" (pos-service docs/KOT_ONLY_KITCHEN.md). KOT only is the default for every restaurant;
 * "Track Preparing / Ready / Served" brings the old workflow back. Stored per restaurant (PUT /restaurant `kitchen_status_mode`, owner
 * only); the device copy (lib/kitchenStatusMode) follows the server. Lives inside the Restaurant form, so Save is its own button.
 */
export function KitchenStatusCard() {
  const t = useMsg(KITCHEN_STATUS_MSG);
  const current = useKitchenMode();
  const [draft, setDraft] = useState<KitchenStatusMode | null>(null);
  const value = draft ?? current;
  const minutes = useKitchenDisplayMinutes();
  const [minDraft, setMinDraft] = useState<string | null>(null);
  const minText = minDraft ?? String(minutes);
  const minN = Number(minText);
  const minValid = /^\d{1,3}$/.test(minText.trim()) && minN >= DISPLAY_MIN && minN <= DISPLAY_MAX;
  const dirty = value !== current || (minDraft !== null && minN !== minutes);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (saving || !dirty || !minValid) return;
    setSaving(true);
    try {
      // PUT /restaurant replaces name / GSTIN / address, so the current profile goes along unchanged.
      const r = await api.restaurant();
      await api.updateRestaurant({ name: r.name, trn: r.trn, address: r.address ?? null, kitchen_status_mode: value, kitchen_display_minutes: minN });
      setKitchenMode(value); setKitchenDisplayMinutes(minN); setDraft(null); setMinDraft(null); refreshRestaurantMeta();
      toast.success(t("saved"));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : t("fail"));
    } finally { setSaving(false); }
  };
  const options: { id: KitchenStatusMode; label: string; hint: string }[] = [
    { id: "kot_only", label: t("kotOnly"), hint: t("kotOnlyHint") },
    { id: "track", label: t("track"), hint: t("trackHint") },
  ];
  return (
    <Card>
      <CardHeader title={t("title")} description={t("desc")} />
      <div role="radiogroup" aria-label={t("group")} className="grid gap-2" data-testid="kitchen-status-mode">
        {options.map((o) => (
          <label key={o.id} className={cn("flex cursor-pointer items-start gap-3 rounded-xl border p-3", value === o.id ? "border-primary bg-primary-soft/40" : "border-border bg-surface hover:border-border-strong")}>
            <input type="radio" name="kitchen-status-mode" value={o.id} checked={value === o.id} onChange={() => setDraft(o.id)} className="mt-1 size-4 accent-[var(--c-primary)]" />
            <span className="min-w-0"><span className="block font-semibold text-fg">{o.label}</span><span className="block text-sm text-fg-muted">{o.hint}</span></span>
          </label>
        ))}
      </div>
      {value === "kot_only" && (
        <div className="mt-3 w-56">
          <Input label={t("showFor")} inputMode="numeric" value={minText} data-testid="kitchen-display-minutes" hint={t("showForHint")}
            error={minValid ? undefined : t("showForRange", { min: DISPLAY_MIN, max: DISPLAY_MAX })} onChange={(e) => setMinDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void save(); } }} />
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button type="button" iconStart={<ChefHat />} loading={saving} disabled={!dirty || !minValid} onClick={() => void save()}>{t("save")}</Button>
        <p className="text-sm text-fg-muted">{t("note")}</p>
      </div>
    </Card>
  );
}
