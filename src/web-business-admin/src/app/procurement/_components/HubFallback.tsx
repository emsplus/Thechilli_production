import { Skeleton } from "@chilli/ui";

/** Shown while the page reads the URL; same shape as the loaded hub. */
export function HubFallback() {
  return <div role="status" aria-busy="true"><span className="ch-sr-only">Loading</span><Skeleton height={44} /><div className="mt-4"><Skeleton height={240} /></div></div>;
}
