import { fmtMoney } from "./format";

const LABEL: Record<string, string> = {
  amount_minor: "Amount", base_amount_minor: "Base", fields: "Fields", from: "From", to: "To", source_id: "Merged from", provider: "Provider",
  document_id: "Document", platform_status: "Platform", billing_status: "Billing", key: "Item", status: "Status", type: "Type", size: "Size",
};
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-/i;

function value(k: string, v: unknown, currency: string): string {
  if (typeof v === "number" && k.endsWith("_minor")) return fmtMoney(v, currency);
  if (k === "size" && typeof v === "number") return v >= 1048576 ? `${(v / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(v / 1024))} KB`;
  if (Array.isArray(v)) return v.map(String).join(", ");
  if (v === null || v === undefined) return "none";
  if (typeof v === "string" && ID.test(v)) return `#${v.slice(-6)}`;
  if (typeof v === "object") return Object.entries(v as Record<string, unknown>).map(([a, b]) => `${a} ${String(b)}`).join(", ");
  return String(v).replace(/_/g, " ");
}

/** Audit meta as readable text: "Amount: ₹1,200 · Status: approved". Money fields (`*_minor`) are formatted, never shown raw. */
export function formatAuditMeta(meta: Record<string, unknown> | null | undefined, currency = "INR"): string {
  if (!meta) return "";
  return Object.entries(meta).map(([k, v]) => `${LABEL[k] ?? k.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())}: ${value(k, v, currency)}`).join(" · ");
}
