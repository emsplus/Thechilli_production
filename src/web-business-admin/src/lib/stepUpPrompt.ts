import { ApiError } from "./api";
import { isStepUpRequired } from "./devices";

/**
 * Step-up retry (pos-service docs/STAFF_PIN_DEVICES_API.md 5). A void, or a discount over the cashier cap, may answer 403
 * "step-up required" (only with STEP_UP_REQUIRED on the server). withStepUp() then asks for the PIN through the dialog
 * mounted once by <StepUpHost /> (src/components/devices/StepUpHost.tsx), and retries once: api.ts adds the in-memory
 * X-Step-Up-Token to that retry. Cancelled -> ApiError(403, code "step_up_cancelled").
 */
type Prompt = (what: string) => Promise<boolean>;
let prompt: Prompt | null = null;

/** Called by StepUpHost on mount; returns the unregister function. */
export function registerStepUpPrompt(p: Prompt): () => void {
  prompt = p;
  return () => { if (prompt === p) prompt = null; };
}

export const isStepUpCancelled = (e: unknown) => e instanceof ApiError && e.code === "step_up_cancelled";

export async function withStepUp<T>(run: () => Promise<T>, what: string): Promise<T> {
  try { return await run(); }
  catch (e) {
    if (!isStepUpRequired(e) || !prompt) throw e;
    if (!(await prompt(what))) throw new ApiError(403, `Your PIN is needed to ${what}.`, "step_up_cancelled");
    return run();
  }
}
