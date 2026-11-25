import { cn } from "@/lib/cn";

export function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd className={cn("inline-flex min-w-5 items-center justify-center rounded-md border border-border-strong border-b-2 bg-surface px-1.5 py-0.5 font-mono text-[0.7rem] font-medium text-fg-muted", className)}>
      {children}
    </kbd>
  );
}
