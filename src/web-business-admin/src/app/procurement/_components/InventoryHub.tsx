"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Boxes } from "lucide-react";
import { Card, EmptyState } from "@/components/ui";
import { PageHeader, PillTabs, Skeleton } from "@chilli/ui";
import { api, auth } from "@/lib/api";
import { useLocale, useMsg } from "@/lib/i18n";
import { inv, isMissing, SECTION_READ, type SectionId, type StockItem, type StockLocation } from "@/lib/inventoryApi";
import { useCan } from "@/lib/useRole";
import type { Supplier } from "@/lib/types";
import { INV_MSG } from "./messages";
import { RefsProvider, type Refs } from "./shared";
import { OrdersSection } from "./OrdersSection";
import { ReceiptsSection } from "./ReceiptsSection";
import { WastageSection } from "./WastageSection";
import { BatchesSection } from "./BatchesSection";
import { CountsSection } from "./CountsSection";
import { LocationsSection } from "./LocationsSection";

const ORDER: SectionId[] = ["orders", "receipts", "wastage", "batches", "counts", "locations"];
/** A cheap first request per section: a 404/405/501 hides the tab instead of showing an error later. */
const PROBE: Record<SectionId, () => Promise<unknown>> = {
  orders: () => inv.pos({ limit: 1 }), receipts: () => inv.receipts({ limit: 1 }), wastage: () => inv.wastage(),
  batches: () => inv.batches({ limit: 1 }), counts: () => inv.counts(1), locations: () => inv.locations(),
};

export function InventoryHub() {
  const t = useMsg(INV_MSG);
  const { locale } = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { can, ready } = useCan();
  const [hidden, setHidden] = useState<Set<SectionId> | null>(null);
  const [items, setItems] = useState<StockItem[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [locations, setLocations] = useState<StockLocation[]>([]);

  const allowed = useMemo(() => ORDER.filter((s) => SECTION_READ[s].some((p) => can(p))), [can]);

  useEffect(() => {
    if (!auth.token) { router.replace("/login"); return; }
    if (!ready) return;
    let off = false;
    void (async () => {
      const gone = new Set<SectionId>();
      await Promise.all(allowed.map(async (s) => { try { await PROBE[s](); } catch (e) { if (isMissing(e)) gone.add(s); } }));
      if (!off) setHidden(gone);
    })();
    // Reference data for the forms; failures just leave the pickers empty (the section shows its own error).
    void inv.items().then((x) => { if (!off) setItems(x); }).catch(() => {});
    void api.allSuppliers().then((x) => { if (!off) setSuppliers(x); }).catch(() => {});
    void inv.locations().then((x) => { if (!off) setLocations(x); }).catch(() => {});
    return () => { off = true; };
  }, [ready, allowed, router]);

  const reloadLocations = useCallback(() => { void inv.locations().then(setLocations).catch(() => {}); }, []);
  const refs = useMemo<Refs>(() => {
    const im = new Map(items.map((i) => [i.id, i])); const sm = new Map(suppliers.map((s) => [s.id, s.name])); const lm = new Map(locations.map((l) => [l.id, l.name]));
    return { items, suppliers, locations, itemById: (id) => im.get(id), itemName: (id) => im.get(id)?.name ?? "Item", supplierName: (id) => sm.get(id) ?? "Supplier", locationName: (id) => lm.get(id) ?? "", reloadLocations };
  }, [items, suppliers, locations, reloadLocations]);

  const visible = allowed.filter((s) => !hidden?.has(s));
  const raw = params.get("tab") as SectionId | null;
  const tab: SectionId | undefined = raw && visible.includes(raw) ? raw : visible[0];
  const setTab = (v: string) => router.replace(`${pathname}?tab=${v}`, { scroll: false });

  const header = <PageHeader title={t("title")} description={t("subtitle")} />;
  if (!ready || hidden === null) return <>{header}<div role="status" aria-busy="true"><span className="ch-sr-only">{t("loading")}</span><Skeleton height={44} /><div className="mt-4"><Skeleton height={240} /></div></div></>;
  if (!allowed.length) return <>{header}<Card><EmptyState icon={<Boxes />} title={t("noAccess")} hint={t("noAccessHint")} /></Card></>;
  if (!visible.length || !tab) return <>{header}<Card><EmptyState icon={<Boxes />} title={t("noneAvailable")} hint={t("noneAvailableHint")} /></Card></>;

  return (
    <RefsProvider value={refs}>
      {header}
      <div className="mb-4 max-w-full overflow-x-auto">
        <PillTabs label={t("sections")} value={tab} onValueChange={setTab} items={visible.map((s) => ({ value: s, label: t(s), content: null }))} />
      </div>
      <div data-locale={locale}>
        {tab === "orders" && <OrdersSection />}
        {tab === "receipts" && <ReceiptsSection />}
        {tab === "wastage" && <WastageSection />}
        {tab === "batches" && <BatchesSection />}
        {tab === "counts" && <CountsSection />}
        {tab === "locations" && <LocationsSection />}
      </div>
    </RefsProvider>
  );
}
