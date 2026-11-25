import type { Key } from "./i18n";
import type { QueuedOp } from "./queue/types";

/** Localised queue label; the stored English `label` is only the fallback (and carries the token for takeaway orders). */
export function opLabel(o: QueuedOp, t: (k: Key, v?: Record<string, string | number>) => string): string {
  const base = t(`op.${o.op.type}` as Key);
  const extra = o.label.split(" · ").slice(1).join(" · ");
  return extra ? `${base} · ${extra}` : base;
}
