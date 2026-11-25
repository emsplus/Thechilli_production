import { Suspense } from "react";
import OrderDetailClient from "./OrderDetailClient";

// Static export (native build) needs a known param set. Real ids are passed as `/orders/_/?id=<id>` there.
// In the normal server build every other id is still rendered on demand.
export function generateStaticParams() { return [{ id: "_" }]; }

export default function Page() { return <Suspense fallback={<main id="main" className="main">Loading...</main>}><OrderDetailClient /></Suspense>; }
