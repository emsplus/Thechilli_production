import type { HttpClient } from "./client";
import { createApi } from "./endpoints";

/** Calls every typed endpoint once with dummy arguments and returns the "METHOD /path" it would send. For contract tests. */
export async function recordApiCalls(): Promise<string[]> {
  const calls: string[] = [];
  const rec = (m: string) => async (p: string) => { calls.push(`${m} ${p}`); return {} as never; };
  const spy: HttpClient = { get: rec("GET"), getText: rec("GET"), post: rec("POST"), put: rec("PUT"), patch: rec("PATCH"), delete: rec("DELETE") };
  const api = createApi(spy);
  for (const group of Object.values(api)) for (const fn of Object.values(group) as ((...a: string[]) => Promise<unknown>)[]) await fn("a", "b", "c" as never);
  return calls;
}
