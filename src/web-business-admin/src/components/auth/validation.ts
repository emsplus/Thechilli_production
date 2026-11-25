import { AUTH_MSG } from "./messages";

/** English zod messages (src/lib/passwords.ts, login schema) -> AUTH_MSG key, so field errors follow the chosen language. */
const KEYS: Record<string, keyof typeof AUTH_MSG> = {
  "At least 10 characters": "vPwMin",
  "The two passwords do not match": "vPwMatch",
  "Enter your current password": "vCurrent",
  "Enter a valid email address": "vEmailAddr",
  "Enter a valid email": "vEmail",
  "Password required": "vPwRequired",
};

/** `t` is a translator for AUTH_MSG (useMsg(AUTH_MSG)). Unknown messages (e.g. from the server) pass through. */
export function fieldError(t: (key: string) => string, message?: string): string | undefined {
  if (!message) return undefined;
  const k = KEYS[message];
  return k ? t(k) : message;
}
