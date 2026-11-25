"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ChevronDown, ChevronUp, Copy, Download, Eraser } from "lucide-react";
import { toast } from "@/components/ui";
import { cn } from "@/lib/cn";
import { runningRecognisers } from "@/lib/liveSpeech";
import { clearMicLog, formatLine, micDebugShown, micLines, micLogText, subscribeMicDebugShown, subscribeMicLog } from "@/lib/micLog";
import { wakeSensitivity } from "@/lib/wakeWord";

/**
 * TESTING PHASE: the "Mic debug" box next to the mic (owner, 2026-11-02; MIC_DEBUG_DEFAULT in micLog.ts turns it off for
 * customers). Live plain-text log of the recogniser (micLog.ts) with a header (state, recognisers running, language,
 * sensitivity, hands-free, microphone permission, input device) and Clear / Copy log / Download log. On this device only: no
 * network request, no audio. Collapsed by default on a phone.
 */
export function MicDebug({ state, handsFree, lang, detector = "off" }: { state: string; handsFree: boolean; lang: string; detector?: string }) {
  const shown = useSyncExternalStore(subscribeMicDebugShown, micDebugShown, () => false);
  const lines = useSyncExternalStore(subscribeMicLog, micLines, micLines);
  // collapsed by default (it floats over the menu when open), remembered per device
  const [open, setOpenRaw] = useState(() => { try { return localStorage.getItem("pos.micDebugOpen") === "1"; } catch { return false; } });
  const setOpen = (f: (o: boolean) => boolean) => setOpenRaw((o) => { const n = f(o); try { localStorage.setItem("pos.micDebugOpen", n ? "1" : "0"); } catch { /* ignore */ } return n; });
  const [perm, setPerm] = useState("unknown");
  const [device, setDevice] = useState("unknown");
  const [count, setCount] = useState(0);
  const box = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    if (!shown) return;
    let alive = true;
    const read = () => {
      void navigator.permissions?.query?.({ name: "microphone" as PermissionName }).then((p) => { if (alive) setPerm(p.state); }).catch(() => {});
      void navigator.mediaDevices?.enumerateDevices?.().then((d) => {
        const inputs = d.filter((x) => x.kind === "audioinput");
        const def = inputs.find((x) => x.deviceId === "default") ?? inputs[0];
        if (alive) setDevice(def ? def.label || "(label hidden until the mic is allowed)" : "no microphone");
      }).catch(() => {});
    };
    read();
    navigator.mediaDevices?.addEventListener?.("devicechange", read);
    const id = setInterval(() => { setCount(runningRecognisers()); }, 500);
    return () => { alive = false; clearInterval(id); navigator.mediaDevices?.removeEventListener?.("devicechange", read); };
  }, [shown]);
  useEffect(() => { if (open && box.current) box.current.scrollTop = box.current.scrollHeight; }, [lines, open]);
  if (!shown) return null;

  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const browser = /Edg\/([\d.]+)/.exec(ua)?.[0] ?? /Chrome\/([\d.]+)/.exec(ua)?.[0] ?? /Version\/([\d.]+).*Safari/.exec(ua)?.[0] ?? "browser ?";
  const os = /Mac OS X [\d_]+|Windows NT [\d.]+|Android [\d.]+|iPhone OS [\d_]+|Linux/.exec(ua)?.[0]?.replace(/_/g, ".") ?? "OS ?";
  const header = `state ${state} · recognisers ${count} · offline wake detector ${detector} · lang en-IN (${lang}) · sensitivity ${wakeSensitivity()} · hands-free ${handsFree ? "on" : "off"} · mic permission ${perm} · input ${device} · ${browser} · ${os}`;
  const text = () => micLogText(`Chilli Agent mic log ${new Date().toISOString()} · ${header} · ${typeof navigator !== "undefined" ? navigator.userAgent : ""}`);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text()); toast.success("Mic log copied"); }
    catch { toast.error("Could not copy: use Download log"); }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([text()], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url; a.download = `mic-log-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.txt`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const btn = "inline-flex min-h-8 items-center gap-1 rounded-lg border border-border bg-surface px-2 text-[0.7rem] font-semibold text-fg hover:bg-surface-2";
  return (
    <div className="relative" data-testid="mic-debug">
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className={cn(btn, "h-12 rounded-2xl px-2.5")}>
        Mic debug{open ? <ChevronUp aria-hidden className="size-3.5" /> : <ChevronDown aria-hidden className="size-3.5" />}
      </button>
      {open && (
        <div role="region" aria-label="Mic debug log" className="absolute left-0 top-full z-30 mt-1 w-[min(92vw,30rem)] rounded-xl border border-border-strong bg-surface p-2 shadow-lg">
          <p data-testid="mic-debug-header" className="mb-1 break-words font-mono text-[0.65rem] font-semibold text-fg">{header}</p>
          <pre ref={box} data-testid="mic-debug-log" className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[0.65rem] leading-snug">
            {lines.map((l, i) => (
              <span key={`${l.t}-${i}`} className={cn("block", l.kind === "interim" ? "text-fg-muted" : l.kind === "error" ? "text-danger-fg" : l.kind === "wake" ? "font-bold text-success-fg" : "text-fg")}>{formatLine(l)}</span>
            ))}
          </pre>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <button type="button" className={btn} onClick={clearMicLog}><Eraser aria-hidden className="size-3.5" />Clear</button>
            <button type="button" className={btn} onClick={() => void copy()}><Copy aria-hidden className="size-3.5" />Copy log</button>
            <button type="button" className={btn} onClick={download}><Download aria-hidden className="size-3.5" />Download log</button>
            <span className="self-center text-[0.65rem] text-fg-muted">On this device only. Testing build.</span>
          </div>
        </div>
      )}
    </div>
  );
}
