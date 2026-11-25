"use client";

import { createContext, useContext, useId, useState, type ComponentProps } from "react";
import * as T from "@radix-ui/react-tabs";
import { motion } from "motion/react";
import { cn } from "@/lib/cn";
import { layoutTransition } from "@/lib/motion";

const Ctx = createContext<{ value: string; id: string }>({ value: "", id: "" });

/**
 * Tabs (Radix: roving focus, arrow keys, aria) with a sliding underline.
 * <Tabs defaultValue="a"><TabsList><TabsTrigger value="a">A</TabsTrigger></TabsList><TabsContent value="a">..</TabsContent></Tabs>
 */
export function Tabs({ value, defaultValue = "", onValueChange, className, ...props }: ComponentProps<typeof T.Root>) {
  const [inner, setInner] = useState(defaultValue);
  const current = value ?? inner;
  const id = useId();
  return (
    <Ctx.Provider value={{ value: current, id }}>
      <T.Root value={current} onValueChange={(v) => { setInner(v); onValueChange?.(v); }} className={className} {...props} />
    </Ctx.Provider>
  );
}

export function TabsList({ className, ...props }: ComponentProps<typeof T.List>) {
  return <T.List className={cn("flex gap-1 overflow-x-auto border-b border-border scrollbar-thin", className)} {...props} />;
}

export function TabsTrigger({ value, className, children, ...props }: ComponentProps<typeof T.Trigger>) {
  const { value: active, id } = useContext(Ctx);
  return (
    <T.Trigger
      value={value}
      className={cn("relative inline-flex h-11 shrink-0 items-center gap-2 px-4 text-sm font-semibold text-fg-muted transition-colors hover:text-fg data-[state=active]:text-primary-soft-fg", className)}
      {...props}
    >
      {children}
      {active === value && <motion.span layoutId={`tab-${id}`} className="absolute inset-x-2 -bottom-px h-[3px] rounded-full bg-primary" transition={layoutTransition} />}
    </T.Trigger>
  );
}

export function TabsContent({ className, ...props }: ComponentProps<typeof T.Content>) {
  return <T.Content className={cn("pt-4 focus-visible:outline-offset-4", className)} {...props} />;
}
