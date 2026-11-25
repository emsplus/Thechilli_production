import { Suspense } from "react";
import { EndOfDay, EndOfDayFallback } from "./_components/EndOfDay";

export const metadata = { title: "End of day" };

/** X report (today so far), closing the day (Z report) and the Z history. `?z=<id>` opens one stored report; `?tab=history` the list. */
export default function EndOfDayPage() {
  return (
    <Suspense fallback={<EndOfDayFallback />}>
      <EndOfDay />
    </Suspense>
  );
}
