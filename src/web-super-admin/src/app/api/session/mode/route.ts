import { NextResponse } from "next/server";
import { apiMode, demoCredentialsVisible } from "@/server/config";
import { DEMO_ACCOUNTS, DEMO_PASSWORD } from "@/server/mock/seed";

export const dynamic = "force-dynamic";

/** Public: tells the sign-in page whether it is a demo. Demo credentials are only returned when HQ_API_MODE=mock was set explicitly. */
export async function GET() {
  const mode = apiMode();
  return NextResponse.json(demoCredentialsVisible() ? { mode, demo: { password: DEMO_PASSWORD, accounts: DEMO_ACCOUNTS } } : { mode });
}
