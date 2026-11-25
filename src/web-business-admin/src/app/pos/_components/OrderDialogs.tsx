"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Ban, Check, LogIn, Plus, ReceiptText, SlidersHorizontal, Undo2, Utensils } from "lucide-react";
import { Button, Dialog } from "@chilli/ui";
import { toast } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";
import { returnToAfterSignIn } from "@/lib/returnTo";
import { formatCurrency } from "@/lib/money";
import type { DiningTable, MenuItem, TableStatus } from "@/lib/types";

/** A table that already has an order was picked: add to that order, or start a separate one. */
export interface BusyTableAsk { ticketId: string; tableId: string; orderId: string | null; afterPlace: boolean }

const TABLE_POLL_MS = 15_000;

/** Live table states (GET /tables/status), refreshed every 15 s while the page is visible and online. Empty map when unknown. */
export function useTableStatus(enabled: boolean) {
  const [rows, setRows] = useState<TableStatus[]>([]);
  const refresh = useCallback(async () => {
    try { setRows(await api.tableStatus()); } catch { /* older server or offline: tables show without a state */ }
  }, []);
  useEffect(() => {
    if (!enabled) return;
    void Promise.resolve().then(refresh);
    const id = setInterval(() => { if (!document.hidden) void refresh(); }, TABLE_POLL_MS);
    const vis = () => { if (!document.hidden) void refresh(); };
    document.addEventListener("visibilitychange", vis);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", vis); };
  }, [enabled, refresh]);
  const byId = useMemo(() => new Map(rows.map((r) => [r.table_id, r])), [rows]);
  return { byId, refresh };
}

const today = () => new Date().toLocaleDateString("en-CA");
const KEY = "pos.soldOut";
function readLocal(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as { day: string; ids: string[] } | null;
    return new Set(raw && raw.day === today() ? raw.ids : []);
  } catch { return new Set(); }
}
function writeLocal(ids: Set<string>) { try { localStorage.setItem(KEY, JSON.stringify({ day: today(), ids: [...ids] })); } catch { /* storage unavailable */ } }

/**
 * Sold out today (C-16). The server flag (`sold_out`, resets at midnight) wins; a server without the sold-out endpoint keeps the
 * mark on this device only, for today (it clears itself the next day), and says so.
 */
export function useSoldOut(items: MenuItem[], online: boolean) {
  const [server, setServer] = useState<Map<string, boolean>>(new Map());
  const [local, setLocal] = useState<Set<string>>(new Set());
  const [menuFor, setMenuFor] = useState<{ item: MenuItem; choose: () => void } | null>(null);
  useEffect(() => { void Promise.resolve().then(() => setLocal(readLocal())); }, []);
  const isSoldOut = useCallback((item: MenuItem) => {
    const s = server.get(item.id);
    if (s !== undefined) return !s;
    return item.sold_out === true || local.has(item.id);
  }, [server, local]);
  const list = useMemo(() => items.filter(isSoldOut), [items, isSoldOut]);
  const setSoldOut = useCallback(async (item: MenuItem, out: boolean) => {
    const keepLocal = () => {
      setLocal((prev) => { const n = new Set(prev); if (out) n.add(item.id); else n.delete(item.id); writeLocal(n); return n; });
    };
    if (!online) { keepLocal(); toast.message(out ? `${item.name}: sold out (this device only)` : `${item.name} is back`, { description: "Other devices see it once the internet is back and it is marked again." }); return; }
    try {
      const r = await api.setSoldOut(item.id, out);
      setServer((m) => new Map(m).set(item.id, r.sold_out !== true));
      setLocal((prev) => { if (!prev.has(item.id)) return prev; const n = new Set(prev); n.delete(item.id); writeLocal(n); return n; });
      toast.success(out ? `${item.name} marked sold out` : `${item.name} is back on the menu`, { description: out ? "It cannot be added until it is back." : undefined });
    } catch (e) {
      if (e instanceof ApiError && [404, 405, 501].includes(e.status)) {
        keepLocal();
        toast.message(out ? `${item.name} marked sold out on this device` : `${item.name} is back on this device`, { description: "Other tills do not see this yet." });
        return;
      }
      toast.error(e instanceof ApiError && e.status === 403 ? "A manager must do this" : "Could not change it", { description: "Please try again." });
    }
  }, [online]);
  const openMenu = useCallback((item: MenuItem, choose: () => void) => setMenuFor({ item, choose }), []);
  return { isSoldOut, list, setSoldOut, menuFor, openMenu, closeMenu: () => setMenuFor(null) };
}

const NOTE_CHIPS = ["No onion", "No garlic", "Less spicy", "Extra spicy", "Jain", "Less oil"];

export function OrderDialogs({ busyAsk, tables, tableStatus, currency, onBusyClose, onAddToTableOrder, onSeparateOrder, billExists, onBillExistsClose, onUseExistingBill, onReplaceBill, canChangeBill,
  note, onNoteClose, onNoteSave, soldOut, canMarkSoldOut, signedOut }: {
  busyAsk: BusyTableAsk | null; tables: DiningTable[]; tableStatus: Map<string, TableStatus>; currency: string;
  onBusyClose: () => void; onAddToTableOrder: (a: BusyTableAsk) => void; onSeparateOrder: (a: BusyTableAsk) => void;
  billExists: { ticketId: string; billId: string | null; canReplace: boolean } | null; onBillExistsClose: () => void;
  onUseExistingBill: (b: { ticketId: string; billId: string | null }) => void; onReplaceBill: (b: { ticketId: string }) => void; canChangeBill: boolean;
  note: { name: string; note: string } | null; onNoteClose: () => void; onNoteSave: (text: string) => void;
  soldOut: ReturnType<typeof useSoldOut>; canMarkSoldOut: boolean;
  signedOut: boolean;
}) {
  const table = busyAsk ? tables.find((t) => t.id === busyAsk.tableId) : undefined;
  const st = busyAsk ? tableStatus.get(busyAsk.tableId) : undefined;
  const items = st?.orders.reduce((n, o) => n + (o.item_count ?? 0), 0) ?? 0;
  const total = st?.orders.reduce((n, o) => n + Number(o.subtotal ?? 0), 0) ?? 0;
  const dish = soldOut.menuFor?.item;
  const dishOut = dish ? soldOut.isSoldOut(dish) : false;
  return (
    <>
      <Dialog open={busyAsk !== null} onOpenChange={(o) => { if (!o) onBusyClose(); }}
        title={`Table ${table?.label ?? ""} already has an order`}
        description={st && items ? `${items} ${items === 1 ? "item" : "items"} · ${formatCurrency(total.toFixed(2), currency)}` : "Someone already started an order on this table."}>
        {busyAsk && (
          <div className="grid gap-3 pb-3" data-testid="busy-table-choice">
            <Button variant="primary" size="pay" className="w-full justify-start" iconStart={<Plus />} onClick={() => onAddToTableOrder(busyAsk)}>Add to this table&rsquo;s order</Button>
            <Button variant="secondary" size="pay" className="w-full justify-start" iconStart={<Utensils />} onClick={() => onSeparateOrder(busyAsk)}>Start a separate order</Button>
            <p className="text-sm text-fg-muted">A separate order gets its own bill (for example a second group at the same table).</p>
          </div>
        )}
      </Dialog>

      <Dialog open={billExists !== null} onOpenChange={(o) => { if (!o) onBillExistsClose(); }}
        title="A bill already exists: change its discount?"
        description="This order was already billed (maybe the first tap went through). The new discount is NOT on that bill.">
        {billExists && (
          <div className="grid gap-3 pb-3" data-testid="bill-exists">
            {billExists.canReplace && (
              <Button variant="primary" size="pay" className="w-full justify-start" iconStart={<ReceiptText />} onClick={() => onReplaceBill(billExists)}>Change the bill to this discount</Button>
            )}
            <Button variant={billExists.canReplace ? "secondary" : "primary"} size="pay" className="w-full justify-start" iconStart={<ReceiptText />} onClick={() => onUseExistingBill(billExists)}>Use the existing bill</Button>
            {!billExists.canReplace && <p className="text-sm text-fg-muted">{canChangeBill ? "To change the discount, open the bill from Orders and use Correct bill." : "To change the discount, ask a manager or owner to correct the bill."}</p>}
          </div>
        )}
      </Dialog>

      <NoteDialog note={note} onClose={onNoteClose} onSave={onNoteSave} />

      <Dialog open={!!dish} onOpenChange={(o) => { if (!o) soldOut.closeMenu(); }} title={dish?.name ?? "Dish"}
        description={dishOut ? "Sold out today. It cannot be added." : "Choose what to do with this dish."}>
        {dish && (
          <div className="grid gap-3 pb-3" data-testid="dish-menu">
            {!dishOut && (dish.variants.length > 0 || (dish.modifier_group_ids?.length ?? 0) > 0) && (
              <Button variant="secondary" size="lg" className="w-full justify-start" iconStart={<SlidersHorizontal />} onClick={() => { const c = soldOut.menuFor!.choose; soldOut.closeMenu(); c(); }}>Choose size and options</Button>
            )}
            {canMarkSoldOut ? (
              <Button variant={dishOut ? "primary" : "danger-soft"} size="lg" className="w-full justify-start" iconStart={dishOut ? <Undo2 /> : <Ban />}
                onClick={() => { void soldOut.setSoldOut(dish, !dishOut); soldOut.closeMenu(); }}>{dishOut ? "Back in stock" : "Mark sold out today"}</Button>
            ) : <p className="text-sm text-fg-muted">Only a manager can mark a dish sold out.</p>}
          </div>
        )}
      </Dialog>

      <Dialog open={signedOut} onOpenChange={() => {}} title="Session expired, sign in again"
        description="You were signed out for safety. Your order is saved: everything on this screen is kept on this device and comes back after you sign in.">
        <div className="pb-3" data-testid="session-expired">
          <Button variant="primary" size="pay" className="w-full" iconStart={<LogIn />} onClick={() => { returnToAfterSignIn("/pos"); window.location.assign(new URL("/login", window.location.origin).href); }}>Sign in again</Button>
        </div>
      </Dialog>
    </>
  );
}

function NoteDialog({ note, onClose, onSave }: { note: { name: string; note: string } | null; onClose: () => void; onSave: (text: string) => void }) {
  const [text, setText] = useState("");
  const [last, setLast] = useState<typeof note>(null);
  if (note && note !== last) { setLast(note); setText(note.note); }
  const has = (chip: string) => text.split(",").map((x) => x.trim().toLowerCase()).includes(chip.toLowerCase());
  const toggle = (chip: string) => setText((t) => {
    const parts = t.split(",").map((x) => x.trim()).filter(Boolean);
    return (has(chip) ? parts.filter((x) => x.toLowerCase() !== chip.toLowerCase()) : [...parts, chip]).join(", ");
  });
  return (
    <Dialog open={note !== null} onOpenChange={(o) => { if (!o) onClose(); }} title={`Note for ${note?.name ?? "this dish"}`}
      description="The kitchen sees this on the kitchen ticket."
      footer={<Button variant="primary" className="w-full" size="lg" iconStart={<Check />} onClick={() => onSave(text)} data-testid="note-save">Save note</Button>}>
      <div className="space-y-3 pb-3">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Quick notes">
          {NOTE_CHIPS.map((c) => (
            <button key={c} type="button" aria-pressed={has(c)} onClick={() => toggle(c)}
              className={cn("inline-flex min-h-11 items-center gap-1.5 rounded-xl border px-3 text-sm font-semibold transition-colors active:scale-[0.97]",
                has(c) ? "border-primary bg-primary-soft text-primary-soft-fg" : "border-border-strong bg-surface text-fg hover:bg-surface-2")}>
              {has(c) && <Check aria-hidden className="size-4" />}{c}
            </button>
          ))}
        </div>
        <label className="block text-sm font-semibold text-fg">Or type a note
          <input value={text} maxLength={300} onChange={(e) => setText(e.target.value)} placeholder="e.g. no onion" className="ch-input mt-1 w-full"
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onSave(text); } }} />
        </label>
      </div>
    </Dialog>
  );
}
