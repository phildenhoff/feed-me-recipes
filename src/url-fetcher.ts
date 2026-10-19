/**
 * Fetches recipe page HTML and extracts structured data from it.
 *
 * Fetching is two-tier:
 *   1. A direct request that honestly identifies itself as a bot. Spoofing a
 *      browser User-Agent from Node is counterproductive: Cloudflare and
 *      Facebook both flag "Chrome UA without Chrome's TLS fingerprint and
 *      client-hint headers" as a bot and reject it, while an honest UA is
 *      usually allowed through.
 *   2. If the direct request is rejected with a bot-protection status, retry
 *      through the Jina Reader proxy (https://r.jina.ai), which renders the
 *      page in a real browser and returns the HTML. This gets past PerimeterX
 *      and Cloudflare's lighter rules, but not a full managed challenge.
 *
 * If both tiers fail, a SiteBlockedError with a human-readable explanation is
 * thrown so the notification tells the user why the import failed.
 */

const BOT_USER_AGENT =
  'FeedMeRecipes/1.0 (+https://github.com/phildenhoff/feed-me-recipes)';

const FETCH_HEADERS = {
  'User-Agent': BOT_USER_AGENT,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

const READER_PROXY_BASE = 'https://r.jina.ai/';

const FETCH_TIMEOUT_MS = 10_000;
const READER_PROXY_TIMEOUT_MS = 45_000;

/** HTTP statuses that mean "a bot-protection layer rejected us", not "the page is gone". */
const BLOCKED_STATUSES = new Set([401, 403, 406, 429, 503]);

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
  ) {
    super(`HTTP ${status} fetching ${url}`);
    this.name = 'HttpError';
  }
}

export class SiteBlockedError extends Error {
  constructor(
    public readonly hostname: string,
    public readonly directStatus: number,
    public readonly readerProxyDetail: string,
  ) {
    super(
      `${hostname} blocks automated requests (HTTP ${directStatus} direct; reader proxy: ${readerProxyDetail}). ` +
        'Open the recipe in a browser and share the recipe text instead.',
    );
    this.name = 'SiteBlockedError';
  }
}

export function isBlockedStatus(status: number): boolean {
  return BLOCKED_STATUSES.has(status);
}

export async function fetchHtmlDirect(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: FETCH_HEADERS,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new HttpError(response.status, url);
  }

  return response.text();
}

export type ReaderProxyOptions = {
  /** Optional Jina API key; raises rate limits and enables proxy rendering. */
  apiKey?: string;
};

export async function fetchHtmlViaReaderProxy(
  url: string,
  options: ReaderProxyOptions = {},
): Promise<string> {
  const headers: Record<string, string> = {
    'User-Agent': BOT_USER_AGENT,
    'X-Respond-With': 'html',
  };
  if (options.apiKey) {
    headers.Authorization = `Bearer ${options.apiKey}`;
  }

  const proxiedUrl = `${READER_PROXY_BASE}${url}`;
  const response = await fetch(proxiedUrl, {
    headers,
    signal: AbortSignal.timeout(READER_PROXY_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new HttpError(response.status, proxiedUrl);
  }

  return response.text();
}

export type HtmlFetcher = (url: string) => Promise<string>;

/**
 * Builds the production fetcher: direct first, reader proxy on bot-protection
 * statuses, SiteBlockedError if both are rejected. Non-blocking failures
 * (404, network errors, timeouts) propagate unchanged.
 */
export function makeHtmlFetcher(deps: {
  direct: HtmlFetcher;
  readerProxy: HtmlFetcher;
}): HtmlFetcher {
  return async (url) => {
    try {
      return await deps.direct(url);
    } catch (directError) {
      if (!(directError instanceof HttpError) || !isBlockedStatus(directError.status)) {
        throw directError;
      }

      const hostname = new URL(url).hostname.replace(/^www\./, '');
      console.warn(
        `[fetcher] ${hostname} returned HTTP ${directError.status}; retrying via reader proxy`,
      );

      try {
        return await deps.readerProxy(url);
      } catch (proxyError) {
        const detail =
          proxyError instanceof HttpError
            ? `HTTP ${proxyError.status}`
            : proxyError instanceof Error
              ? proxyError.message
              : String(proxyError);
        throw new SiteBlockedError(hostname, directError.status, detail);
      }
    }
  };
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

    const recipe = items.find((item) => {
      if (!item || typeof item !== 'object') return false;
      const type = (item as Record<string, unknown>)['@type'];
      return type === 'Recipe' || (Array.isArray(type) && type.includes('Recipe'));
    });

    if (recipe) {
      return recipe as Record<string, unknown>;
    }
  }

  return null;
}

/**
 * Returns the raw (still HTML-escaped) content of a <meta> tag matched by its
 * `property` or `name` attribute, or null if absent. Handles either attribute
 * order.
 */
export function extractMetaContent(html: string, key: string): string | null {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const keyFirst = new RegExp(
    `<meta[^>]+(?:property|name)="${escapedKey}"[^>]+content="([^"]*)"`,
    'i',
  );
  const contentFirst = new RegExp(
    `<meta[^>]+content="([^"]*)"[^>]+(?:property|name)="${escapedKey}"`,
    'i',
  );
  const match = keyFirst.exec(html) ?? contentFirst.exec(html);
  return match?.[1] ?? null;
}

/**
 * Extracts the OpenGraph image URL from raw HTML.
 * Returns null if no og:image meta tag is found.
 */
export function extractOpenGraphImageUrl(html: string): string | null {
  const raw = extractMetaContent(html, 'og:image');
  return raw ? decodeHtmlEntities(raw) : null;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Decodes the numeric and common named entities found in HTML attributes. */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const codePoint =
        body[1] === 'x' || body[1] === 'X'
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}
