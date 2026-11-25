"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { AiChat } from "@/components/ai/AiChat";
import { cn } from "@/lib/cn";

interface AiDrawerCtx { open: boolean; setOpen: (o: boolean) => void; toggle: () => void }
const Ctx = createContext<AiDrawerCtx>({ open: false, setOpen: () => {}, toggle: () => {} });
export const useAiDrawer = () => useContext(Ctx);

export function AiDrawerProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((o) => !o), []);
  const value = useMemo(() => ({ open, setOpen, toggle }), [open, toggle]);
  return <Ctx.Provider value={value}>{children}<AiDrawer /></Ctx.Provider>;
}

/**
 * The AI assistant as a side panel over any page: opened from the top-bar button, the page underneath stays usable.
 * Mounted on first open and then kept (hidden), so the conversation survives closing and moving between pages.
 */
function AiDrawer() {
  const { open, setOpen } = useAiDrawer();
  const [mounted, setMounted] = useState(false);
  if (open && !mounted) setMounted(true); // first open mounts the chat; it then stays mounted (hidden) to keep the conversation
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !document.querySelector("[role=dialog]")) setOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, setOpen]);
  if (!mounted) return null;
  return (
    <aside aria-label="AI assistant" inert={!open} aria-hidden={!open}
      className={cn("fixed inset-y-0 right-0 z-50 flex w-full flex-col overflow-hidden border-l border-border bg-surface shadow-modal pb-safe transition-transform duration-200 ease-out sm:w-[26rem] sm:rounded-l-3xl", open ? "translate-x-0" : "pointer-events-none translate-x-full")}>
      <AiChat active={open} onClose={() => setOpen(false)} />
    </aside>
  );
}
