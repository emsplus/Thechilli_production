"use client";
import { useEffect, useRef, useState } from "react";
import { api, type CustomerDto } from "@/lib/api";
import { useDialogFocus } from "@/lib/dialogFocus";
import { useOnline } from "@/lib/sync";

const nameOf = (c: CustomerDto) => c.name?.trim() || c.phone || "Customer";

/** Attach a customer to the bill (original counter: "Add customer"). Search needs the server; adding a new one needs CRM permission. */
export function CustomerSheet({ onPick, onClose }: { onPick: (c: { id: string; name: string }) => void; onClose: () => void }) {
  const online = useOnline();
  const [q, setQ] = useState("");
  const [list, setList] = useState<CustomerDto[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(ref, onClose);
  useEffect(() => {
    if (!online) return;
    const ctl = new AbortController();
    const h = setTimeout(() => {
      api.customers(q.trim(), ctl.signal).then((r) => { setList(r.slice(0, 20)); setErr(null); }).catch((e: unknown) => { if (!ctl.signal.aborted) setErr(e instanceof Error ? e.message : "Search failed"); });
    }, q ? 300 : 0);
    return () => { clearTimeout(h); ctl.abort(); };
  }, [q, online]);

  async function create() {
    if (busy || (!name.trim() && !phone.trim())) return;
    setBusy(true); setErr(null);
    try { const c = await api.createCustomer(name, phone); onPick({ id: c.id, name: nameOf(c) }); }
    catch (e) {
      const m = e instanceof Error ? e.message : "";
      setErr(/403|permission|forbidden/i.test(m) ? "Your role cannot add new customers. Ask the cashier or manager, or pick an existing one." : `Could not add the customer${m ? `: ${m}` : ""}`);
      setBusy(false);
    }
  }

  return (
    <div className="sheet" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Add customer" tabIndex={-1} ref={ref} onClick={(e) => e.stopPropagation()}>
        <div className="grabber" aria-hidden />
        <div className="row sheet-head"><h2 className="sheet-title grow">Add customer</h2>
          <button className="iconbtn" aria-label="Close" onClick={onClose}><svg viewBox="0 0 24 24" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg></button></div>
        {!online ? <div className="banner">Customer search needs a connection. Send the order now; the cashier can add the customer to the bill.</div> : adding ? (
          <>
            <label className="field"><span>Name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" /></label>
            <label className="field"><span>Mobile number</span><input className="input" type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="98765 43210" /></label>
            {err && <div className="banner err" role="alert">{err}</div>}
            <div className="row"><button className="btn grow" onClick={() => setAdding(false)}>Back</button><button className="btn primary grow" disabled={busy || (!name.trim() && !phone.trim())} onClick={() => void create()}>{busy ? "Saving..." : "Save and add"}</button></div>
          </>
        ) : (
          <>
            <div className="search" style={{ marginBottom: 12 }}>
              <svg viewBox="0 0 24 24" aria-hidden><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></svg>
              <input type="search" autoFocus aria-label="Search customers" placeholder="Name or mobile number" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            {err && <div className="banner err" role="alert">{err}</div>}
            {list === null && !err && <p className="muted">Searching...</p>}
            {list && !list.length && <p className="muted">No customer found{q ? ` for "${q}"` : ""}.</p>}
            <ul className="plainlist">
              {list?.map((c) => (
                <li key={c.id}><button className="optrow" onClick={() => onPick({ id: c.id, name: nameOf(c) })}><span className="clip">{nameOf(c)}</span><span className="muted small">{c.name ? c.phone ?? "" : ""}</span></button></li>
              ))}
            </ul>
            <button className="btn block" style={{ marginTop: 8 }} onClick={() => { setAdding(true); if (/^[\d\s+]+$/.test(q)) setPhone(q); else setName(q); }}>+ New customer</button>
          </>
        )}
      </div>
    </div>
  );
}
