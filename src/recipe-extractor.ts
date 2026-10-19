import type { InstagramPost } from './apify.js';
import type { FacebookPost } from './facebook.js';
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
  isFacebookUrl: (url: string) => boolean;
  extractFacebookPost: (html: string) => FacebookPost | null;
  parseRecipeFromCaption: (caption: string) => Promise<ParseResult>;
  parseRecipeFromJsonLd: (jsonLd: Record<string, unknown>) => Promise<ParseResult>;
  parseRecipeFromJsonLdAndCaption: (
    jsonLd: Record<string, unknown>,
    caption: string,
  ) => Promise<ParseResult>;
};

/** Social-network hosts whose links in a caption point back at the network, not at a recipe site. */
const SOCIAL_HOST_PATTERN =
  /(?:www\.|m\.)?(?:instagram\.com|facebook\.com|fb\.com|fb\.watch|threads\.net|tiktok\.com|youtube\.com|youtu\.be)/i;

export function extractUrlFromCaption(caption: string): string | null {
  // Collapse line-broken URLs (e.g. "https://example.com/foo\nbar/")
  const normalized = caption.replace(/\n(?=\S)/g, '');
  const urlPattern = /(?:https?:\/\/|www\.)[^\s]+/gi;
  let match: RegExpExecArray | null;

  while ((match = urlPattern.exec(normalized)) !== null) {
    // Strip trailing punctuation that may be part of surrounding text
    const candidate = match[0].replace(/[.,)>\]]+$/, '');
    const url = candidate.startsWith('http') ? candidate : `https://${candidate}`;

    let hostname: string;
    try {
      hostname = new URL(url).hostname;
    } catch {
      continue;
    }
    if (SOCIAL_HOST_PATTERN.test(hostname)) continue;

    return url;
  }

  return null;
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

type CaptionSource = {
  /** URL the user shared. */
  url: string;
  caption: string;
  /** Display name, e.g. "Instagram @handle" or "Facebook Fit Foodie Lulu". */
  sourceName: string;
  imageUrl?: string;
};

/**
 * Shared path for caption-based sources (Instagram, Facebook).
 *
 * Prefers JSON-LD from a site linked in the caption over caption-only parsing:
 * it has exact measurements and step-by-step instructions, and Haiku merges it
 * with the caption to preserve the creator's tips and variations.
 *
 * Caption-only parsing is the fallback because Haiku will hallucinate
 * quantities from vague captions — "season to taste" becomes "1 tsp salt"
 * with no detectable signal that the value was invented.
 */
async function extractRecipeFromCaption(
  source: CaptionSource,
  deps: ExtractionDeps,
): Promise<ExtractionResult> {
  const linkedUrl = extractUrlFromCaption(source.caption);
  const jsonLd = linkedUrl ? await tryFetchJsonLd(linkedUrl, deps) : null;

  let recipe: Recipe;
  let sourceUrl = source.url;

  if (jsonLd && linkedUrl) {
    console.log(`[extractor] Using JSON-LD from ${linkedUrl} merged with caption`);
    const result = await deps.parseRecipeFromJsonLdAndCaption(jsonLd, source.caption);
    if (!result.is_recipe) return { ok: false, reason: result.reason };
    recipe = result.recipe;
    sourceUrl = linkedUrl;
  } else {
    if (linkedUrl) {
      console.warn(`[extractor] No JSON-LD at ${linkedUrl}, falling back to caption`);
    }
    const result = await deps.parseRecipeFromCaption(source.caption);
    if (!result.is_recipe) return { ok: false, reason: result.reason };
    recipe = result.recipe;
  }

  const photo = source.imageUrl ? await deps.downloadImage(source.imageUrl) : undefined;

  return {
    ok: true,
    value: { recipe, sourceUrl, sourceName: source.sourceName, photo },
  };
}

export async function extractRecipeFromInstagram(
  url: string,
  deps: ExtractionDeps,
): Promise<ExtractionResult> {
  const post = await deps.fetchInstagramPost(url);
  return extractRecipeFromCaption(
    {
      url,
      caption: post.caption,
      sourceName: `Instagram @${post.ownerUsername}`,
      imageUrl: deps.getPostImageUrl(post),
    },
    deps,
  );
}

export async function extractRecipeFromFacebook(
  url: string,
  deps: ExtractionDeps,
): Promise<ExtractionResult> {
  const html = await deps.fetchHtml(url);
  const post = deps.extractFacebookPost(html);

  if (!post) {
    return {
      ok: false,
      reason:
        'Could not read the Facebook post without logging in (private post, login wall, or unsupported post type)',
    };
  }

  console.log(
    `[extractor] Facebook post by ${post.authorName ?? 'unknown author'} (${post.caption.length} chars)`,
  );

  return extractRecipeFromCaption(
    {
      url,
      caption: post.caption,
      sourceName: post.authorName ? `Facebook ${post.authorName}` : 'Facebook',
      imageUrl: post.imageUrl ?? undefined,
    },
    deps,
  );
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
  if (deps.isFacebookUrl(url)) {
    return extractRecipeFromFacebook(url, deps);
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
