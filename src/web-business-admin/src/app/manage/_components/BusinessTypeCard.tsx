"use client";

import { useEffect, useMemo, useState } from "react";
import { Store } from "lucide-react";
import { Button, Checkbox, Notice } from "@chilli/ui";
import { Card, CardHeader, toast, useConfirm } from "@/components/ui";
import { ApiError } from "@/lib/api";
import { BUSINESS_TYPE_IDS, bizCapsOf, capsOfSelection, hiddenBy, typeHint, type BusinessType } from "@/lib/business";
import { businessTypes, type BusinessTypeInfo } from "@/lib/deliveryApi";
import type { Restaurant } from "@/lib/types";

const OPEN_ORDERS = "Close or bill all open orders first. Removing Restaurant hides Tables, Dine-in and Reservations.";

/**
 * Manage > Restaurant > "Business type" (docs/BUSINESS_TYPES.md): what the business runs (one or more of Restaurant or cafe,
 * Cloud kitchen, Hotel kitchen). Everyone with access sees it; only the owner (settings.owner) changes it. Removing a type only
 * hides its screens (nothing is deleted); the server refuses while orders are open. Hidden on a server without business types.
 */
export function BusinessTypeCard({ restaurant, canEdit }: { restaurant: Restaurant | null; canEdit: boolean }) {
  const confirm = useConfirm();
  const [cat, setCat] = useState<BusinessTypeInfo[] | null | "none">(null);
  const [picked, setPicked] = useState<BusinessType[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let off = false;
    businessTypes.catalogue().then((c) => { if (!off) setCat(Array.isArray(c) && c.length ? c : "none"); }).catch(() => { if (!off) setCat("none"); });
    return () => { off = true; };
  }, []);

  const saved = useMemo<BusinessType[]>(() => {
    const t = (restaurant?.business_types ?? ["restaurant"]).filter((x): x is BusinessType => (BUSINESS_TYPE_IDS as readonly string[]).includes(x));
    return t.length ? t : ["restaurant"];
  }, [restaurant]);
  const sel = picked ?? saved;
  if (cat === "none" || (cat !== null && !restaurant?.business_types)) return null; // older server: no business types yet
  if (!cat || !restaurant) return null;

  const dirty = sel.length !== saved.length || sel.some((x) => !saved.includes(x));
  const toggle = (id: BusinessType, on: boolean) => {
    setErr(null);
    const next = on ? [...sel, id] : sel.filter((x) => x !== id);
    setPicked(BUSINESS_TYPE_IDS.filter((x) => next.includes(x))); // canonical order
  };

  async function save() {
    if (!sel.length) { setErr("Choose at least one."); return; }
    const before = bizCapsOf(restaurant);
    const after = capsOfSelection(sel, cat as BusinessTypeInfo[]);
    const lost = hiddenBy(before, after);
    if (lost.length && !(await confirm({
      title: "Change the business type?",
      description: `${lost.join(", ")} will be hidden. Nothing is deleted: they come back when you select the type again. ${OPEN_ORDERS}`,
      confirmLabel: "Change business type", tone: "danger",
    }))) return;
    setSaving(true); setErr(null);
    try {
      await businessTypes.set(sel);
      toast.success("Business type saved. Reloading the screens for it.");
      // Every screen reads the capabilities from /auth/me: reload so navigation, the POS and Manage follow the new selection.
      setTimeout(() => window.location.reload(), 600);
    } catch (e) {
      if (e instanceof ApiError && e.code === "open_orders_block_business_type_change") setErr(OPEN_ORDERS);
      else setErr(e instanceof ApiError ? (e.status === 0 ? "No connection. Try again when online." : e.message) : "Could not save the business type");
    } finally { setSaving(false); }
  }

  return (
    <Card data-testid="business-type">
      <CardHeader title="Business type" description="What you run. The screens follow it: choose one or more." />
      <fieldset disabled={!canEdit || saving} className="space-y-1">
        <legend className="sr-only">What do you run? (choose one or more)</legend>
        {cat.map((c) => (
          <Checkbox key={c.id} label={c.label} checked={sel.includes(c.id)} onChange={(e) => toggle(c.id, e.target.checked)}
            hint={typeHint(c)} />
        ))}
      </fieldset>
      {!canEdit && <p className="mt-3 text-sm text-fg-muted">Only the owner can change the business type.</p>}
      {err && <Notice tone="danger" className="mt-3">{err}</Notice>}
      {canEdit && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button type="button" iconStart={<Store />} loading={saving} disabled={!dirty || sel.length === 0} onClick={() => void save()}>Save business type</Button>
          {dirty && sel.length > 0 && <span className="text-xs text-fg-muted">{OPEN_ORDERS.split(".")[0]}.</span>}
        </div>
      )}
    </Card>
  );
}
