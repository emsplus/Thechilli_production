import { Suspense } from "react";
import { ManagePanel, ManageFallback } from "./_components/ManagePanel";

export const metadata = { title: "Manage" };

/** One panel for everything back-office. The active section lives in `?tab=` (read client-side, so wrapped in Suspense). */
export default function ManagePage() {
  return (
    <Suspense fallback={<ManageFallback />}>
      <ManagePanel />
    </Suspense>
  );
}
