import type { LeadStage } from "./api/types";

export const PIPELINE_STAGES: LeadStage[] = ["new", "contacted", "qualified", "demo_scheduled", "demo_done", "negotiation"];
export const BOARD_STAGES: LeadStage[] = [...PIPELINE_STAGES, "won", "lost"];

export const STAGE_LABEL: Record<LeadStage, string> = {
  new: "New", contacted: "Contacted", qualified: "Qualified", demo_scheduled: "Demo scheduled", demo_done: "Demo done",
  negotiation: "Negotiation", won: "Won", lost: "Lost",
};

/**
 * Stage moves the backend accepts (marketing-service DESIGN section 3): forward freely, back one step, lost from any
 * open stage, lost re-opens only to new, won is terminal and only set by provisioning (never offered here).
 */
export function allowedStages(from: LeadStage): LeadStage[] {
  if (from === "won") return [];
  if (from === "lost") return ["new"];
  const i = PIPELINE_STAGES.indexOf(from);
  const out: LeadStage[] = [];
  if (i > 0) out.push(PIPELINE_STAGES[i - 1]!);
  out.push(...PIPELINE_STAGES.slice(i + 1), "lost");
  return out;
}
