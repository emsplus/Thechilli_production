/**
 * The one place that decides how a 403 step_up_required gets its grant. Framework-free so it can be tested; the dialog
 * (src/components/StepUpDialog.tsx) registers itself as the prompter.
 *
 *  - an unspent grant for the same action is reused first (a validation error after confirming must not cost another code);
 *  - otherwise the person is asked, ONE dialog at a time: a second protected request that fails while the dialog is open waits
 *    for its turn and gets its own dialog afterwards (grants are single use, so each action needs its own code). Never stacked.
 */
import { GrantStore, type HeldGrant, type StepUpGrant, type StepUpProvider } from "./step-up";

export interface PromptRequest { key: string }
/** Resolves with a grant, or null when the person cancels (or no dialog is mounted). */
export type Prompter = (req: PromptRequest) => Promise<StepUpGrant | null>;

export class StepUpCoordinator implements StepUpProvider {
  private prompter: Prompter | null = null;
  private dismiss: (() => void) | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  constructor(readonly store: GrantStore = new GrantStore()) {}

  /** `dismiss` closes the open dialog without an answer (it resolves as a cancel). */
  setPrompter(p: Prompter | null, dismiss: (() => void) | null = null) { this.prompter = p; this.dismiss = dismiss; }
  /** Sign-out / session end: nothing may outlive the session it was granted for, and an open dialog has nothing left to confirm. */
  clear() { this.store.clear(); this.dismiss?.(); }

  acquire(key: string): Promise<HeldGrant | null> {
    const run = this.chain.then(async () => {
      const grant = this.store.take(key) ?? (this.prompter ? await this.prompter({ key }) : null);
      return grant ? this.loan(key, grant) : null;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  private loan(key: string, grant: StepUpGrant): HeldGrant {
    let settled = false;
    return {
      token: grant.token,
      settle: (spent) => { if (settled) return; settled = true; if (!spent) this.store.put(key, grant); },
    };
  }
}

export const stepUpCoordinator = new StepUpCoordinator();
