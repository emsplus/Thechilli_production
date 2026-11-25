import type { ChecklistKey } from "./api/types";

export const CHECKLIST_ORDER: ChecklistKey[] = ["business_type", "outlet", "menu", "staff", "documents"];
export const CHECKLIST_LABEL: Record<ChecklistKey, string> = {
  business_type: "Business type", outlet: "Outlet", menu: "Menu", staff: "Staff", documents: "Documents",
};
/** Readiness blockers come from the API as developer text ("checklist item 'menu' is in_progress"). Show them in plain words. */
export function blockerText(b: string): string {
  const m = /^checklist item '([a-z_]+)' is ([a-z_]+)$/.exec(b);
  if (m && m[1]! in CHECKLIST_LABEL) return `${CHECKLIST_LABEL[m[1] as ChecklistKey]}: ${m[2]!.replace(/_/g, " ")}`;
  if (b === "owner name and owner email are required") return "Owner name and owner email";
  return b.charAt(0).toUpperCase() + b.slice(1);
}
/** Wizard order: owner details first (needed for readiness), then the five checklist items. */
export const WIZARD_STEPS = ["owner", ...CHECKLIST_ORDER] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];
export const isWizardStep = (s: string): s is WizardStep => (WIZARD_STEPS as readonly string[]).includes(s);
