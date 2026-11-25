"use client";

import { useCallback, useRef, useState, type ReactNode } from "react";
import { ConfirmDialog } from "@chilli/ui";

export interface AskOptions { title: string; description?: string; confirmLabel: string; destructive?: boolean }

/**
 * Promise-style confirm built on the design system's ConfirmDialog: `if (!(await ask({...}))) return;` and render `node` once.
 * Destructive confirms start focused on Cancel (that is the ConfirmDialog contract).
 */
export function useAsk(): [(o: AskOptions) => Promise<boolean>, ReactNode] {
  const [opts, setOpts] = useState<AskOptions | null>(null);
  const [open, setOpen] = useState(false);
  const resolver = useRef<((v: boolean) => void) | null>(null);
  const ask = useCallback((o: AskOptions) => new Promise<boolean>((resolve) => {
    resolver.current?.(false);
    resolver.current = resolve; setOpts(o); setOpen(true);
  }), []);
  const done = (v: boolean) => { resolver.current?.(v); resolver.current = null; setOpen(false); };
  const node = opts && (
    <ConfirmDialog open={open} onOpenChange={(o) => { if (!o) done(false); }} title={opts.title} description={opts.description}
      confirmLabel={opts.confirmLabel} destructive={opts.destructive} onConfirm={() => done(true)} />
  );
  return [ask, node];
}
