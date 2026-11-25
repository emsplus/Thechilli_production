/** Human heading for a table area code from the server ("dine_in" -> "Dine-in", "outdoor" -> "Outdoor", "first_floor" -> "First floor"). */
const KNOWN: Record<string, string> = { dine_in: "Dine-in", dinein: "Dine-in", indoor: "Indoor", outdoor: "Outdoor", takeaway: "Takeaway", delivery: "Delivery", ac: "AC", non_ac: "Non-AC" };

export function areaLabel(area: string | null | undefined): string {
  const raw = (area ?? "").trim();
  if (!raw) return "Tables";
  const key = raw.toLowerCase().replace(/[\s-]+/g, "_");
  if (KNOWN[key]) return KNOWN[key];
  const words = key.split("_").filter(Boolean).join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
