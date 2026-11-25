"use client";

import { Notice } from "@chilli/ui";
import { useCan } from "@/lib/useRole";

const TEXT: Record<string, string> = {
  past_due: "Your subscription payment is overdue. Everything keeps working; please settle the invoice.",
  entitlements_stale: "Your plan could not be re-checked just now. Everything keeps working for the moment.",
  suspended: "This restaurant's subscription is suspended.",
};

/** Shown only when /auth/me says something about billing (past due, stale, read-only). Nothing at all for a healthy or unmanaged tenant. */
export function EntitlementBanner() {
  const { readOnly, warning } = useCan();
  if (!readOnly && !warning) return null;
  return (
    <div className="page-width mx-auto w-full px-3 pt-3 sm:px-5 lg:pr-6">
      <Notice tone={readOnly ? "danger" : "warning"} title={readOnly ? "Read-only mode" : "Billing notice"}>
        {readOnly ? "Changes are blocked until the subscription is active again. You can still look things up and end the day." : (warning && TEXT[warning]) ?? warning}
      </Notice>
    </div>
  );
}
