/** Human label for the restaurant's time zone. The raw IANA name's last part is a city ("Kolkata"), which reads wrong for a
 *  restaurant in Bengaluru, so people see the zone name instead: "India (IST)". pos-service sends it as `timezone_label` on
 *  GET /restaurant; until every server does, the zone is mapped here (India only product, docs/INR_ONLY.md). */
const KNOWN: Record<string, string> = {
  "Asia/Kolkata": "India (IST)",
  "Asia/Calcutta": "India (IST)", // the older IANA name for the same zone
};

export function timezoneLabel(zone?: string | null, label?: string | null): string {
  const given = typeof label === "string" ? label.trim() : "";
  if (given) return given;
  const z = (zone ?? "").trim();
  if (!z) return "";
  return KNOWN[z] ?? z.replace(/_/g, " ");
}
