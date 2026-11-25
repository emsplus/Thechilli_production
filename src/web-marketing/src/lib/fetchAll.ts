/** Pages through an offset/limit endpoint (max 200 per request on the server) up to `maxPages`. */
export async function fetchAll<T>(page: (offset: number, limit: number) => Promise<T[]>, limit = 200, maxPages = 5): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < maxPages; i++) {
    const rows = await page(i * limit, limit);
    out.push(...rows);
    if (rows.length < limit) break;
  }
  return out;
}
