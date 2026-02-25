import type { InstagramPost } from './apify.js';
import type { ParseResult, Recipe } from './parser.js';

export type RecipeExtraction = {
  recipe: Recipe;
  sourceUrl: string;
  sourceName: string;
  photo?: Buffer;
};

export type ExtractionResult =
  | { ok: true; value: RecipeExtraction }
  | { ok: false; reason: string };

export type ExtractionDeps = {
  fetchInstagramPost: (url: string) => Promise<InstagramPost>;
  getPostImageUrl: (post: InstagramPost) => string | undefined;
  downloadImage: (url: string) => Promise<Buffer | undefined>;
  fetchHtml: (url: string) => Promise<string>;
  extractJsonLd: (html: string) => Record<string, unknown> | null;
  extractOpenGraphImageUrl: (html: string) => string | null;
  parseRecipeFromCaption: (caption: string) => Promise<ParseResult>;
  parseRecipeFromJsonLd: (jsonLd: Record<string, unknown>) => Promise<ParseResult>;
  parseRecipeFromJsonLdAndCaption: (
    jsonLd: Record<string, unknown>,
    caption: string,
  ) => Promise<ParseResult>;
};

function extractUrlFromCaption(caption: string): string | null {
  // Collapse line-broken URLs (e.g. "https://example.com/foo\nbar/")
  const normalized = caption.replace(/\n(?=\S)/g, '');
  // Match both protocol-prefixed and bare www. URLs, but not instagram.com links
  const match = normalized.match(
    /(?:https?:\/\/|www\.)(?!(?:www\.)?instagram\.com)[^\s]+/i,
  );
  if (!match) return null;
  // Strip trailing punctuation that may be part of surrounding text
  const url = match[0].replace(/[.,)>\]]+$/, '');
  return url.startsWith('http') ? url : `https://${url}`;
}

async function tryFetchJsonLd(
  url: string,
  deps: Pick<ExtractionDeps, 'fetchHtml' | 'extractJsonLd'>,
): Promise<Record<string, unknown> | null> {
  try {
    const html = await deps.fetchHtml(url);
    return deps.extractJsonLd(html);
  } catch (err) {
    console.warn(
      `[extractor] Failed to fetch JSON-LD from ${url}: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}

export async function extractRecipeFromInstagram(
  url: string,
  deps: ExtractionDeps,
): Promise<ExtractionResult> {
  const post = await deps.fetchInstagramPost(url);
  const linkedUrl = extractUrlFromCaption(post.caption);
  const jsonLd = linkedUrl ? await tryFetchJsonLd(linkedUrl, deps) : null;

  let recipe: Recipe;
  let sourceUrl = url;

  if (jsonLd && linkedUrl) {
    // Prefer the linked site's JSON-LD over caption-only parsing: it has exact
    // measurements and step-by-step instructions. Haiku merges it with the
    // caption to preserve the creator's tips and variations.
    //
    // Caption-only parsing is the fallback because Haiku will hallucinate
    // quantities from vague captions — "season to taste" becomes "1 tsp salt"
    // with no detectable signal that the value was invented.
    const result = await deps.parseRecipeFromJsonLdAndCaption(jsonLd, post.caption);
    if (!result.is_recipe) return { ok: false, reason: result.reason };
    recipe = result.recipe;
    sourceUrl = linkedUrl;
  } else {
    if (linkedUrl) {
      console.warn(`[extractor] No JSON-LD at ${linkedUrl}, falling back to caption`);
    }
    const result = await deps.parseRecipeFromCaption(post.caption);
    if (!result.is_recipe) return { ok: false, reason: result.reason };
    recipe = result.recipe;
  }

  const imageUrl = deps.getPostImageUrl(post);
  const photo = imageUrl ? await deps.downloadImage(imageUrl) : undefined;

  return {
    ok: true,
    value: {
      recipe,
      sourceUrl,
      sourceName: post.ownerFullName || post.ownerUsername,
      photo,
    },
  };
}

export async function extractRecipeFromUrl(
  url: string,
  deps: ExtractionDeps,
): Promise<ExtractionResult> {
  const html = await deps.fetchHtml(url);
  const jsonLd = deps.extractJsonLd(html);

  if (!jsonLd) {
    return { ok: false, reason: 'No Recipe JSON-LD found on page' };
  }

  const result = await deps.parseRecipeFromJsonLd(jsonLd);
  if (!result.is_recipe) return { ok: false, reason: result.reason };

  const openGraphImageUrl = deps.extractOpenGraphImageUrl(html);
  const photo = openGraphImageUrl ? await deps.downloadImage(openGraphImageUrl) : undefined;

  return {
    ok: true,
    value: {
      recipe: result.recipe,
      sourceUrl: url,
      sourceName: new URL(url).hostname.replace(/^www\./, ''),
      photo,
    },
  };
}

export async function extractRecipeFromSource(
  url: string,
  deps: ExtractionDeps,
): Promise<ExtractionResult> {
  if (url.includes('instagram.com')) {
    return extractRecipeFromInstagram(url, deps);
  }
  return extractRecipeFromUrl(url, deps);
}

export type Extractor = {
  fromSource: (url: string) => Promise<ExtractionResult>;
};

export function makeExtractor(deps: ExtractionDeps): Extractor {
  return {
    fromSource: (url) => extractRecipeFromSource(url, deps),
  };
}
