/**
 * Fetches recipe structured data (Schema.org JSON-LD) from a URL.
 * Best-effort: throws on network/HTTP errors, returns null if no Recipe JSON-LD found.
 */

const FETCH_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

export async function fetchHtml(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: FETCH_HEADERS,
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching ${url}`);
  }

  return response.text();
}

/**
 * Extracts a Schema.org Recipe object from raw HTML.
 * Handles both top-level @type:"Recipe" and @graph arrays.
 * Returns null if no Recipe JSON-LD block is found.
 */
export function extractJsonLd(html: string): Record<string, unknown> | null {
  const scriptPattern =
    /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;

  while ((match = scriptPattern.exec(html)) !== null) {
    let data: unknown;
    try {
      data = JSON.parse(match[1]);
    } catch {
      continue;
    }

    // Normalise to an array — handles @graph and top-level arrays
    const items: unknown[] = Array.isArray(data)
      ? data
      : Array.isArray((data as Record<string, unknown>)['@graph'])
        ? ((data as Record<string, unknown>)['@graph'] as unknown[])
        : [data];

    const recipe = items.find(
      (item) =>
        item &&
        typeof item === 'object' &&
        (item as Record<string, unknown>)['@type'] === 'Recipe'
    );

    if (recipe) {
      return recipe as Record<string, unknown>;
    }
  }

  return null;
}

/**
 * Extracts the OpenGraph image URL from raw HTML.
 * Returns null if no og:image meta tag is found.
 */
export function extractOpenGraphImageUrl(html: string): string | null {
  const match =
    /<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i.exec(html) ??
    /<meta[^>]+content="([^"]+)"[^>]+property="og:image"/i.exec(html);
  return match?.[1] ?? null;
}
