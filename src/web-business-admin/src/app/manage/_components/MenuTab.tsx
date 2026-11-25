"use client";

import { useMemo, useState } from "react";
import { Archive, Download, Pencil, Plus, RotateCcw, Tags } from "lucide-react";
import { Badge, Button, Checkbox, EmptyState, IconButton, Input, Notice, PillTabs, SegmentedControl, Select, Skeleton, Switch } from "@chilli/ui";
import { DataTable, downloadCsv, toCsv, type DataColumn } from "@chilli/ui/data";
import { FoodImage } from "@/components/pos/food-image";
import { api, ApiError, mediaUrl } from "@/lib/api";
import { cn } from "@/lib/cn";
import { formatCurrency } from "@/lib/money";
import { useAsk } from "@/lib/useAsk";
import { useLoader } from "@/lib/useLoader";
import { useNotify } from "@/lib/useNotify";
import { useCan } from "@/lib/useRole";
import { useCurrency, useTaxConfig } from "@/lib/taxConfig";
import { useMsg } from "@/lib/i18n";
import type { MenuItem } from "@/lib/types";
import { BulkMenuSheet, type BulkKind } from "./BulkMenuSheet";
import { CategoriesSheet } from "./CategoriesSheet";
import { ItemDialog } from "./ItemDialog";
import { MENU_MSG } from "./menu-messages";
import { useManage } from "./manage-context";
import { VoicePhrases } from "./VoicePhrases";
import { ModifiersView } from "@/components/manage/ModifiersView";
import { OffersView } from "@/components/manage/OffersView";
import { VegMark } from "@/components/menu/veg-mark";
import { PhoneMenuList } from "@/components/manage/PhoneMenuList";
import { useMediaQuery } from "@/lib/useMediaQuery";
import { FOOD_LABEL, gstRateText, vegOf } from "@/lib/menuAdmin";

const fetchAll = async () => {
  const [cats, items] = await Promise.all([api.allCategories(), api.allItems()]);
  return { cats: [...cats].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)), items };
};

type Sort = "menu" | "name" | "price-asc" | "price-desc";
/** Long Hindi / Hinglish names wrap instead of being cut off. */
const WRAP = "[overflow-wrap:anywhere]";

type Section = "items" | "modifiers" | "offers" | "voice";
// Owner 2026-11-13: the "Voice phrases" section is not shown (not needed); the code, data and API stay.
const SECTIONS: readonly string[] = ["items", "modifiers", "offers"];

/** Menu, with the original's items view first and the new pieces inside it: modifier groups, offers (and voice phrases). */
export function MenuTab({ view: sectionView }: { view?: string } = {}) {
  const { refresh, goto } = useManage();
  const t = useMsg(MENU_MSG);
  const [ask, askNode] = useAsk();
  const toast = useNotify();
  const { can, feature } = useCan();
  const offersOn = feature("billing.offers"); // Manage > Features: Automatic offers
  const canEdit = can("menu.manage");
  const currency = useCurrency();
  const { data, error, loading, reload } = useLoader(fetchAll);
  const [cat, setCat] = useState("all");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<Sort>("menu");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [archived, setArchived] = useState(false);
  const [dialog, setDialog] = useState<{ item: MenuItem | null } | null>(null);
  const [catsOpen, setCatsOpen] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState<BulkKind | null>(null);
  const [busy, setBusy] = useState(false);
  const cfg = useTaxConfig();
  /** Phones get the compact grouped list (sticky search, collapsed categories, paged rows) instead of cards / table. */
  const phone = useMediaQuery("(max-width: 639.98px)");
  const section: Section = sectionView && SECTIONS.includes(sectionView) ? (sectionView as Section) : "items";
  const setSection = (v: Section) => goto("menu", v === "items" ? undefined : v);

  const cats = useMemo(() => data?.cats ?? [], [data]);
  const activeCats = useMemo(() => cats.filter((c) => c.is_active), [cats]);
  const items = useMemo(() => data?.items ?? [], [data]);
  const catName = useMemo(() => new Map(cats.map((c) => [c.id, c.name])), [cats]);
  const archivedCount = items.filter((i) => !i.is_active).length;
  const visible = useMemo(() => items.filter((i) => archived || i.is_active), [items, archived]);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    const list = visible.filter((i) => (cat === "all" || i.category_id === cat) && (!s || i.name.toLowerCase().includes(s)));
    if (sort === "name") return [...list].sort((a, b) => a.name.localeCompare(b.name));
    if (sort === "price-asc") return [...list].sort((a, b) => Number(a.price) - Number(b.price));
    if (sort === "price-desc") return [...list].sort((a, b) => Number(b.price) - Number(a.price));
    return list;
  }, [visible, cat, q, sort]);
  const current = cat === "all" || activeCats.some((c) => c.id === cat) ? cat : "all";
  /** Bulk actions only touch what is on screen. */
  const selected = useMemo(() => shown.filter((i) => picked.has(i.id)), [shown, picked]);

  const changed = () => { void reload(); refresh(); };
  const toggle = (id: string, on: boolean) => setPicked((p) => { const n = new Set(p); if (on) n.add(id); else n.delete(id); return n; });

  async function setActive(i: MenuItem, on: boolean) {
    if (!on && !(await ask({ title: t("archiveTitle", { name: i.name }), description: t("archiveDesc"), confirmLabel: t("archive"), destructive: true }))) return;
    try { await api.setItemActive(i.id, on); toast.success(on ? t("backOnMenu", { name: i.name }) : t("archived", { name: i.name })); changed(); }
    catch (e) { toast.error(e instanceof ApiError ? e.message : t("updateFail")); }
  }

  async function bulkAvailability(on: boolean) {
    const todo = selected.filter((i) => i.is_active !== on);
    if (todo.length === 0) { toast.info(on ? t("alreadyOn") : t("alreadyOff")); return; }
    setBusy(true);
    let failed = 0;
    for (const i of todo) { try { await api.setItemActive(i.id, on); } catch { failed++; } }
    setBusy(false);
    const ok = todo.length - failed;
    if (ok > 0) toast.success(t(on ? (ok === 1 ? "bulkOnOne" : "bulkOnMany") : ok === 1 ? "bulkOffOne" : "bulkOffMany", { n: ok }));
    if (failed > 0) toast.error(t("bulkFailed", { n: failed }));
    setPicked(new Set()); changed();
  }

  function exportCsv() {
    downloadCsv("menu.csv", toCsv(
      ["Name", "Category", "Price", "Status", "Options", "Food type", "Description"],
      shown.map((i) => [i.name, catName.get(i.category_id) ?? "", Number(i.price), i.is_active ? "Available" : "Archived", i.variants.map((v) => `${v.name} +${v.price_delta}`).join("; "),
        vegOf(i) ? FOOD_LABEL[vegOf(i)!] : "", i.description ?? ""]),
    ));
  }

  const noCats = !loading && activeCats.length === 0;
  const rowActions = (i: MenuItem) => canEdit && (
    <>
      <IconButton label={t("editName", { name: i.name })} icon={<Pencil />} onClick={() => setDialog({ item: i })} />
      {i.is_active
        ? <IconButton label={t("archiveName", { name: i.name })} icon={<Archive />} onClick={() => void setActive(i, false)} />
        : <IconButton label={t("restoreName", { name: i.name })} icon={<RotateCcw />} onClick={() => void setActive(i, true)} />}
    </>
  );

  const columns: DataColumn<MenuItem>[] = [
    ...(canEdit ? [{ key: "pick", header: t("colSelect"), render: (i: MenuItem) => (
      <div className="[&_.ch-check>span]:sr-only"><Checkbox label={t("selectName", { name: i.name })} checked={picked.has(i.id)} onChange={(e) => toggle(i.id, e.target.checked)} /></div>
    ) }] : []),
    { key: "name", header: t("colItem"), sortValue: (i) => i.name.toLowerCase(), csv: (i) => i.name, render: (i) => (
      <div className="flex min-w-48 items-center gap-3 whitespace-normal">
        <FoodImage src={mediaUrl(i.thumb_url ?? i.image_url)} name={i.name} category={catName.get(i.category_id)} variant="thumb" className="size-12 shrink-0 rounded-lg" />
        <div className={cn("min-w-0", WRAP)}>
          <p className="flex items-center gap-1.5 font-semibold">{vegOf(i) && <VegMark kind={vegOf(i)!} />}{i.name}</p>
          {i.description && <p className="line-clamp-2 text-xs text-fg-muted">{i.description}</p>}
          {i.variants.length > 0 && <p className="text-xs text-fg-muted">{i.variants.map((v) => `${v.name} +${formatCurrency(v.price_delta, currency)}`).join(", ")}</p>}
        </div>
      </div>
    ) },
    { key: "cat", header: t("colCategory"), sortValue: (i) => catName.get(i.category_id) ?? "", csv: (i) => catName.get(i.category_id) ?? "", render: (i) => <span className="whitespace-normal">{catName.get(i.category_id) ?? t("uncategorised")}</span> },
    { key: "price", header: t("colPrice"), align: "end", sortValue: (i) => Number(i.price), csv: (i) => Number(i.price), render: (i) => <span className="ch-money font-semibold" translate="no">{formatCurrency(i.price, currency)}</span> },
    { key: "gst", header: "GST", sortValue: (i) => gstRateText(i, cfg?.rates) ?? "", csv: (i) => gstRateText(i, cfg?.rates) ?? "", render: (i) => <span className="whitespace-nowrap text-fg-muted">{gstRateText(i, cfg?.rates) ?? "-"}</span> },
    { key: "status", header: t("colStatus"), sortValue: (i) => (i.is_active ? 0 : 1), csv: (i) => (i.is_active ? "Available" : "Archived"), render: (i) => i.is_active ? <Badge tone="success">{t("available")}</Badge> : <Badge>{t("archivedBadge")}</Badge> },
    { key: "act", header: t("colActions"), align: "end", render: (i) => <div className="flex justify-end gap-1">{rowActions(i)}</div> },
  ];

  const emptyAdd = canEdit ? { actionLabel: t("addFirstItem"), onAction: () => setDialog({ item: null }), actionVariant: "secondary" as const } : {}; // "Add item" above is the primary

  return (
    <>
      {askNode}
      {error && <div className="mb-4"><Notice tone="danger" title={t("loadFail")} action={<Button size="sm" onClick={() => void reload()}>{t("retry")}</Button>}>{error}</Notice></div>}

      <div className="mb-3">
        <PillTabs label={t("sectionLegend")} value={section} onValueChange={(v) => setSection(v as Section)}
          items={[{ value: "items", label: t("sectionItems"), content: null }, { value: "modifiers", label: "Modifier groups", content: null }, ...(offersOn ? [{ value: "offers", label: "Offers", content: null }] : [])]} />
      </div>
      {section === "modifiers" ? (
        <ModifiersView embedded />
      ) : section === "offers" && offersOn ? (
        <OffersView embedded />
      ) : section === "voice" ? (
        <VoicePhrases />
      ) : (<>
        <div className="mb-4 flex flex-wrap items-end gap-x-3 gap-y-4">
          <div className="hidden min-w-0 flex-1 basis-48 sm:block sm:max-w-xs"><Input label={t("searchItems")} type="search" autoComplete="off" placeholder={t("searchPh")} value={q} onChange={(e) => setQ(e.target.value)} /></div>
          <div className="w-44"><Select label={t("sortBy")} value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            <option value="menu">{t("sortMenu")}</option><option value="name">{t("sortName")}</option><option value="price-asc">{t("sortPriceAsc")}</option><option value="price-desc">{t("sortPriceDesc")}</option>
          </Select></div>
          {!phone && <SegmentedControl legend={t("layout")} value={view} onValueChange={(v) => setView(v as "grid" | "list")} options={[{ value: "grid", label: t("grid") }, { value: "list", label: t("list") }]} />}
          {/* Actions: their own right-aligned row until there is room beside the filters (never a ragged half-wrap). */}
          <div className="flex w-full flex-wrap items-center justify-end gap-2 2xl:ml-auto 2xl:w-auto">
            <Button iconStart={<Download />} disabled={shown.length === 0} onClick={exportCsv}>{t("exportCsv")}</Button>
            {canEdit && <Button iconStart={<Tags />} onClick={() => setCatsOpen(true)}>{t("manageCats")}</Button>}
            {canEdit && <Button variant="primary" iconStart={<Plus />} disabled={noCats || loading} onClick={() => setDialog({ item: null })}>{t("addItem")}</Button>}
          </div>
        </div>

        {!noCats && !phone && (
          <div className="mb-3">
            <PillTabs label={t("filterCat")} value={current} onValueChange={setCat}
              items={[{ value: "all", label: t("all"), count: visible.length, content: null }, ...activeCats.map((c) => ({ value: c.id, label: c.name, count: visible.filter((i) => i.category_id === c.id).length, content: null }))]} />
          </div>
        )}
        {archivedCount > 0 && <div className="mb-3 max-w-xs"><Switch label={t("showArchived", { n: archivedCount })} checked={archived} onChange={(e) => setArchived(e.target.checked)} /></div>}

        {canEdit && shown.length > 0 && (
          <div role="region" aria-label={t("bulkActions")} className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-surface-2 px-3 py-2">
            <Checkbox label={t("selectAll")} checked={selected.length === shown.length} onChange={(e) => setPicked(e.target.checked ? new Set(shown.map((i) => i.id)) : new Set())} />
            {selected.length > 0 && (<>
              <p role="status" className="mr-auto text-sm font-semibold">{t("nSelected", { n: selected.length })}</p>
              <Button disabled={busy} onClick={() => void bulkAvailability(false)}>{t("makeUnavailable")}</Button>
              <Button disabled={busy} onClick={() => void bulkAvailability(true)}>{t("makeAvailable")}</Button>
              <Button disabled={busy} onClick={() => setBulk("price")}>{t("changePrice")}</Button>
              <Button disabled={busy} onClick={() => setBulk("category")}>{t("moveToCategory")}</Button>
              <Button variant="ghost" onClick={() => setPicked(new Set())}>{t("clear")}</Button>
            </>)}
          </div>
        )}

        {loading ? (
          <div role="status" aria-label={t("loadingMenu")} className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} height={250} />)}</div>
        ) : noCats ? (
          <EmptyState title={t("startCat")} description={t("startCatDesc")}
            {...(canEdit ? { actionLabel: t("addCat"), onAction: () => setCatsOpen(true) } : {})} />
        ) : visible.length === 0 ? (
          <EmptyState title={t("noItems")} description={t("noItemsDesc")} {...emptyAdd} />
        ) : phone ? (
          <PhoneMenuList cats={activeCats} items={shown} q={q} onQ={setQ} currency={currency} searchLabel={t("searchItems")} searchPh={t("searchPh")} uncategorised={t("uncategorised")}
            row={(i) => <>
              {canEdit && <div className="[&_.ch-check>span]:sr-only"><Checkbox label={t("selectName", { name: i.name })} checked={picked.has(i.id)} onChange={(e) => toggle(i.id, e.target.checked)} /></div>}
              {rowActions(i)}
            </>} />
        ) : shown.length === 0 ? (
          <EmptyState title={t("noMatch")} description={t("noMatchDesc")} />
        ) : view === "grid" ? (
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {shown.map((i) => (
              <li key={i.id} className={cn("flex flex-col overflow-hidden rounded-xl border border-border bg-surface", !i.is_active && "opacity-75")}>
                <div className="relative">
                  <FoodImage src={mediaUrl(i.thumb_url ?? i.image_url)} name={i.name} category={catName.get(i.category_id)} className="aspect-[4/3] w-full" />
                  {!i.is_active && <span className="absolute left-2 top-2"><Badge>{t("archivedBadge")}</Badge></span>}
                  {canEdit && <div className="absolute right-1 top-1 rounded-lg bg-surface [&_.ch-check>span]:sr-only [&_.ch-check]:px-2"><Checkbox label={t("selectName", { name: i.name })} checked={picked.has(i.id)} onChange={(e) => toggle(i.id, e.target.checked)} /></div>}
                </div>
                <div className="flex flex-1 flex-col gap-2 p-3.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className={cn("min-w-0", WRAP)}>
                      <p className="flex items-center gap-1.5 font-semibold text-fg">{vegOf(i) && <VegMark kind={vegOf(i)!} />}{i.name}</p>
                      <p className="text-sm text-fg-muted">{catName.get(i.category_id) ?? t("uncategorised")}{gstRateText(i, cfg?.rates) && <> · <span data-testid="item-gst">{gstRateText(i, cfg?.rates)}</span></>}</p>
                      {i.description && <p className="mt-1 line-clamp-2 text-sm text-fg-muted">{i.description}</p>}
                    </div>
                    <p className="ch-money shrink-0 text-lg font-bold text-fg" translate="no">{formatCurrency(i.price, currency)}</p>
                  </div>
                  {(i.variants.length > 0 || i.is_combo || (i.modifier_group_ids?.length ?? 0) > 0) && <div className="flex flex-wrap gap-1.5">{i.variants.map((v) => <Badge key={v.id} tone="primary">{v.name} +{formatCurrency(v.price_delta, currency)}</Badge>)}
                    {i.is_combo && <Badge tone="info">Combo</Badge>}
                    {(i.modifier_group_ids?.length ?? 0) > 0 && <Badge tone="neutral">{i.modifier_group_ids!.length === 1 ? "1 modifier group" : `${i.modifier_group_ids!.length} modifier groups`}</Badge>}</div>}
                  {canEdit && (
                    <div className="mt-auto flex gap-2 pt-1">
                      <Button className="flex-1" iconStart={<Pencil />} aria-label={t("editName", { name: i.name })} onClick={() => setDialog({ item: i })}>{t("edit")}</Button>
                      {i.is_active
                        ? <IconButton label={t("archiveName", { name: i.name })} icon={<Archive />} onClick={() => void setActive(i, false)} />
                        : <IconButton label={t("restoreName", { name: i.name })} icon={<RotateCcw />} onClick={() => void setActive(i, true)} />}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <DataTable caption={t("caption")} columns={columns} rows={shown} getKey={(i) => i.id} stickyFirstColumn={false} empty={<EmptyState title={t("noMatch")} />} />
        )}
      </>)}

      <ItemDialog open={dialog !== null} onOpenChange={(o) => { if (!o) setDialog(null); }} item={dialog?.item ?? null}
        cats={dialog?.item && !activeCats.some((c) => c.id === dialog.item!.category_id) ? [...activeCats, ...cats.filter((c) => c.id === dialog.item!.category_id)] : activeCats}
        defaultCategory={current !== "all" ? current : activeCats[0]?.id ?? ""} onSaved={changed} />
      <CategoriesSheet open={catsOpen} onOpenChange={setCatsOpen} cats={cats} items={items} onChanged={changed} />
      <BulkMenuSheet kind={bulk} onClose={() => setBulk(null)} items={selected} cats={activeCats} onDone={() => { setPicked(new Set()); changed(); }} />
    </>
  );
}
