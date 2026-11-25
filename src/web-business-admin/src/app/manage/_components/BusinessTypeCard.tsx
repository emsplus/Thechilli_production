"use client";

import { useEffect, useMemo, useState } from "react";
import { Checkbox } from "@chilli/ui";
import { Card, CardHeader } from "@/components/ui";
import { BUSINESS_TYPE_IDS, typeHint, type BusinessType } from "@/lib/business";
import { businessTypes, type BusinessTypeInfo } from "@/lib/deliveryApi";
import type { Restaurant } from "@/lib/types";

/**
 * Manage > Restaurant > "Business type" (docs/BUSINESS_TYPES.md): what the business runs (Restaurant or cafe, Cloud kitchen, Hotel kitchen).
 * READ-ONLY for everyone, the owner included (owner decision 2026-11-25): the type is chosen when the business is created and only
 * Chilli Agent support (super admin) changes it afterwards; the server refuses the owner's change with 403 `business_type_locked`.
 * Hidden on a server without business types.
 */
export function BusinessTypeCard({ restaurant }: { restaurant: Restaurant | null; canEdit?: boolean }) {
  const [cat, setCat] = useState<BusinessTypeInfo[] | null | "none">(null);
  useEffect(() => {
    let off = false;
    businessTypes.catalogue().then((c) => { if (!off) setCat(Array.isArray(c) && c.length ? c : "none"); }).catch(() => { if (!off) setCat("none"); });
    return () => { off = true; };
  }, []);

  const saved = useMemo<BusinessType[]>(() => {
    const t = (restaurant?.business_types ?? ["restaurant"]).filter((x): x is BusinessType => (BUSINESS_TYPE_IDS as readonly string[]).includes(x));
    return t.length ? t : ["restaurant"];
  }, [restaurant]);
  if (cat === "none" || (cat !== null && !restaurant?.business_types)) return null; // older server: no business types yet
  if (!cat || !restaurant) return null;

  return (
    <Card data-testid="business-type">
      <CardHeader title="Business type" description="What you run. The screens follow it." />
      <fieldset disabled className="space-y-1">
        <legend className="sr-only">What do you run?</legend>
        {cat.map((c) => (
          <Checkbox key={c.id} label={c.label} checked={saved.includes(c.id)} onChange={() => { /* read-only */ }} hint={typeHint(c)} />
        ))}
      </fieldset>
      <p className="mt-3 text-sm text-fg-muted" data-testid="business-type-locked">The business type is set by Chilli Agent support. To change it, please contact support.</p>
    </Card>
  );
}
