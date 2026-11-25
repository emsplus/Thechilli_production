"use client";

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { Button, Dialog } from "@chilli/ui";
import { useLocale } from "@/lib/i18n";

export interface ConfirmOptions {
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** "danger" for destructive actions (discard, void, delete). */
  tone?: "default" | "danger";
}

/** Presentational confirm dialog. Built on the design-system Dialog (not its alertdialog ConfirmDialog) so it keeps role=dialog and shares one dialog layer stack with the other @chilli/ui dialogs. */
export function ConfirmDialog({ open, onConfirm, onCancel, title, description, confirmLabel = "Confirm", cancelLabel = "Cancel", tone = "default" }:
  ConfirmOptions & { open: boolean; onConfirm: () => void; onCancel: () => void }) {
  const { locale } = useLocale();
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onCancel(); }} title={String(title)} description={typeof description === "string" ? description : undefined} locale={locale}
      footer={<>
        <Button onClick={onCancel}>{cancelLabel}</Button>
        <Button variant={tone === "danger" ? "danger-soft" : "primary"} onClick={onConfirm} autoFocus>{confirmLabel}</Button>
      </>} />
  );
}

type Confirm = (o: ConfirmOptions) => Promise<boolean>;
const Ctx = createContext<Confirm | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const [open, setOpen] = useState(false);
  const resolver = useRef<((v: boolean) => void) | null>(null);

  const confirm = useCallback<Confirm>((o) => new Promise<boolean>((resolve) => {
    resolver.current?.(false);
    resolver.current = resolve;
    setOpts(o); setOpen(true);
  }), []);
  const settle = (v: boolean) => { resolver.current?.(v); resolver.current = null; setOpen(false); };

  return (
    <Ctx.Provider value={confirm}>
      {children}
      {opts && <ConfirmDialog {...opts} open={open} onConfirm={() => settle(true)} onCancel={() => settle(false)} />}
    </Ctx.Provider>
  );
}

/**
 * Themed, promise-based replacement for window.confirm:
 *   const confirm = useConfirm();
 *   if (await confirm({ title: "Discard this order?", description: "...", tone: "danger", confirmLabel: "Discard" })) { ... }
 */
export function useConfirm(): Confirm {
  const c = useContext(Ctx);
  if (!c) throw new Error("useConfirm must be used inside <ConfirmProvider> (mounted in the root layout)");
  return c;
}
