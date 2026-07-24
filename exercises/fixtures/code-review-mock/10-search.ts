/** Uses X-Api-Key — inconsistent with 05-http-client Authorization Bearer */
export async function searchCatalog(
  query: string,
  apiKey: string,
): Promise<unknown[]> {
  const url = `https://api.example.com/search?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: { "X-Api-Key": apiKey },
  });
  return (await res.json()) as unknown[];
}
