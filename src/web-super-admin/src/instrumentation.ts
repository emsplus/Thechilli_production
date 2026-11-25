import { assertConfig } from "@/server/config";

/** Runs once when the server starts. Production refuses to boot on an unsafe API-mode configuration. */
export function register() {
  assertConfig();
}
