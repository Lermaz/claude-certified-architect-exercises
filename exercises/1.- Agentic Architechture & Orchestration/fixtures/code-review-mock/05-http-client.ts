export type HttpHeaders = Record<string, string>;

/** Uses Authorization: Bearer — other modules use X-Api-Key inconsistently */
export async function apiGet(
  url: string,
  apiKey: string,
): Promise<unknown> {
  const headers: HttpHeaders = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
  };
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
