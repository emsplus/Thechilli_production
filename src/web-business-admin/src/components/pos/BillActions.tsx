"use client";

import { useState, useSyncExternalStore } from "react";
import { Copy, Download, MessageCircle, Printer } from "lucide-react";
import { toast } from "@/components/ui";
import { Button, Checkbox, Dialog, Input } from "@chilli/ui";
import { createOrFindCustomer, customerLabel } from "@/lib/customers";
import { api, ApiError } from "@/lib/api";
import { downloadBlob, printBlob, shareFile, waDigits, waUrl } from "@/lib/printing";
import { formatCurrency } from "@/lib/money";
import { useHasPrinters } from "@/lib/printJobs";
import { ThermalPrint } from "./ThermalPrint";
import type { Bill, Customer } from "@/lib/types";

const subscribe = (cb: () => void) => {
  window.addEventListener("online", cb); window.addEventListener("offline", cb);
  return () => { window.removeEventListener("online", cb); window.removeEventListener("offline", cb); };
};
const useOnline = () => useSyncExternalStore(subscribe, () => navigator.onLine, () => true);

const fail = (e: unknown, fallback: string) => toast.error(e instanceof ApiError ? e.message : e instanceof Error ? e.message : fallback);

/**
 * Print / Download / WhatsApp for a finalized bill (server thermal PDF). WhatsApp: share the real PDF through the OS
 * share sheet when supported, otherwise create an expiring public link and open wa.me with a ready message.
 */
/** WhatsApp is the Indian e-bill action: the original showed it as a solid green button (WhatsApp green, white text). */
const WA = "!border-transparent !bg-[#0f7a40] !text-white hover:!bg-[#0b6434]"; // 5.4:1 white on green (the lighter #128c4a was 4.3:1)

export function BillActions({ bill, phone, restaurantName, onCustomerSaved }: {
  bill: Bill; phone?: string | null; restaurantName?: string;
  /** Called with the customer saved from the WhatsApp dialog ("Save this number as a customer"). */
  onCustomerSaved?: (c: Customer) => void;
}) {
  const online = useOnline();
  const thermal = useHasPrinters();
  const [busy, setBusy] = useState<string | null>(null);
  const [wa, setWa] = useState(false);
  const [num, setNum] = useState("");
  const [link, setLink] = useState<string | null>(null);
  const [custName, setCustName] = useState("");
  /** null = untouched: follows "a name was typed"; true/false once the checkbox itself was clicked. */
  const [saveChoice, setSaveChoice] = useState<boolean | null>(null);
  const save = saveChoice ?? custName.trim() !== "";
  // The finalized bill is immutable: saving only creates the customer for next time. Offer it when the bill has none.
  const offerSave = !phone && !bill.customer_name && !bill.customer_phone;
  const seller = restaurantName ?? bill.seller_name;
  const message = (url?: string) => `Thank you for dining at ${seller}! Your bill ${bill.invoice_number} (${formatCurrency(bill.total, bill.currency)})${url ? `: ${url}` : ""}`;
  const defaultPhone = phone ?? bill.customer_phone ?? "";
  const hint = online ? undefined : "Needs a connection";

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    try { await fn(); } catch (e) { fail(e, "Something went wrong"); } finally { setBusy(null); }
  }

  const print = () => run("print", async () => { await printBlob(await api.receiptBlob(bill.id)); });
  // Invoice numbers are INV/2627/000042: a slash cannot be part of a file name.
  const fileName = `${bill.invoice_number.replace(/[\\/:*?"<>|]+/g, "-")}.pdf`;
  const download = () => run("dl", async () => downloadBlob(await api.receiptBlob(bill.id), fileName));

  const startWhatsApp = () => run("wa", async () => {
    const blob = await api.receiptBlob(bill.id);
    const r = await shareFile(blob, fileName, message());
    if (r !== "unsupported") return;
    setNum(defaultPhone); setLink(null); setCustName(""); setSaveChoice(null); setWa(true);
  });

  async function ensureLink() {
    if (link) return link;
    const l = await api.shareLink(bill.id);
    setLink(l.url);
    return l.url;
  }

  const sendWa = () => {
    const digits = waDigits(num);
    if (!digits) { toast.error("Enter a valid mobile number, e.g. 98765 43210 or +919876543210"); return; }
    const tab = window.open("about:blank", "_blank"); // opened synchronously so pop-up blockers allow it
    void run("wa", async () => {
      try {
        if (offerSave && save) await saveCustomer(); // before WhatsApp opens; never blocks sending
        const url = await ensureLink();
        const target = waUrl(digits, message(url));
        if (tab) { tab.opener = null; tab.location.href = target; } else window.open(target, "_blank");
        setWa(false);
      } catch (e) { tab?.close(); throw e; }
    });
  };

  async function saveCustomer() {
    try {
      const d = waDigits(num); // the same +91 number WhatsApp opened, never a number the server would read with another country code
      const { customer, existed } = await createOrFindCustomer({ name: custName, phone: d ? `+${d}` : num });
      onCustomerSaved?.(customer);
      if (existed) toast.message(`Already a customer: ${customerLabel(customer)}`);
      else toast.success(`Saved ${customerLabel(customer)} as a customer`);
    } catch (e) {
      toast.error("Could not save the customer", { description: e instanceof ApiError ? e.message : "The bill is still sent." });
    }
  }

  const copy = () => run("copy", async () => {
    const url = await ensureLink();
    try { await navigator.clipboard.writeText(url); toast.success("Receipt link copied"); }
    catch { window.prompt("Copy this link", url); }
  });

  const off = !online || busy !== null;
  return (
    <div data-testid="bill-actions" className="space-y-1.5">
      {thermal && <ThermalPrint kind="bill" refId={bill.id} onPdf={() => void print()} />}
      <div className="grid grid-cols-2 gap-2">
        <Button variant="secondary" disabled={off} loading={busy === "print"} iconStart={<Printer />} onClick={() => void print()} title={hint}>{thermal ? "Print PDF" : "Print"}</Button>
        <Button variant="secondary" disabled={off} loading={busy === "dl"} iconStart={<Download />} onClick={() => void download()} title={hint}>Download PDF</Button>
        <Button variant="secondary" disabled={off} loading={busy === "wa" && !wa} iconStart={<MessageCircle />} onClick={() => void startWhatsApp()} title={hint} className={`col-span-2 ${WA}`}>Share on WhatsApp</Button>
      </div>
      {!online && <p className="text-xs text-fg-muted">Printing and sharing the PDF need a connection. Offline, use the provisional receipt.</p>}
      <Dialog open={wa} onOpenChange={setWa} title="Send bill on WhatsApp" description={`${bill.invoice_number} · ${formatCurrency(bill.total, bill.currency)}`}
        footer={<div className="flex w-full gap-2">
          <Button variant="secondary" disabled={busy !== null} iconStart={<Copy />} onClick={() => void copy()}>Copy link</Button>
          <Button variant="secondary" className={`flex-1 ${WA}`} disabled={busy !== null} loading={busy === "wa"} iconStart={<MessageCircle />} onClick={sendWa}>Open WhatsApp</Button>
        </div>}>
        <div className="space-y-3 pb-3">
          <Input label="Customer mobile number" inputMode="tel" autoComplete="off" placeholder="98765 43210 or +919876543210" value={num} onChange={(e) => setNum(e.target.value)} />
          {offerSave && (
            <div className="space-y-1 rounded-xl border border-border bg-surface-2/50 px-3 pb-3 pt-1">
              <Checkbox label="Save this number as a customer" hint="So their name and number are ready next time. This bill does not change." checked={save} onChange={(e) => setSaveChoice(e.target.checked)} />
              <Input label="Customer name (optional)" autoComplete="off" placeholder="e.g. Priya Sharma" value={custName} onChange={(e) => setCustName(e.target.value)} />
            </div>
          )}
          <p className="text-xs text-fg-muted">We open WhatsApp with a ready message and a link to the PDF bill. The link works for 30 days, but only opens for the customer when this app is hosted on a public address (on a laptop it works on this computer only).</p>
        </div>
      </Dialog>
    </div>
  );
}
