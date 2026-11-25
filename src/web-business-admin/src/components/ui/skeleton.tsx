import { cn } from "@/lib/cn";

/** Shimmering placeholder. Size it with className (h-4 w-32 ...). */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn("skeleton rounded-md", className)} />;
}

/** Convenience: n stacked text lines. */
export function SkeletonLines({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn("space-y-2", className)} role="status" aria-label="Loading">
      {Array.from({ length: lines }, (_, i) => <Skeleton key={i} className={cn("h-4", i === lines - 1 ? "w-2/3" : "w-full")} />)}
    </div>
  );
}
