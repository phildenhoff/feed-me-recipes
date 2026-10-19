/**
 * Facebook post support.
 *
 * Facebook share links (facebook.com/share/r/..., fb.watch/...) redirect to a
 * logged-out post page. That page has no JSON-LD and the visible caption is
 * behind a login wall, but the OpenGraph tags carry everything we need:
 *
 *   og:title  "88K views · 1.2K reactions | <full caption> | <author>"
 *   og:image  cover image
 *
 * og:description is truncated to ~200 characters, so og:title is the source
 * of the caption even though it looks like the wrong tag.
 */

import { decodeHtmlEntities, extractMetaContent } from './url-fetcher.js';

const FACEBOOK_HOSTNAMES = new Set([
  'facebook.com',
  'www.facebook.com',
  'm.facebook.com',
  'web.facebook.com',
  'fb.com',
  'www.fb.com',
  'fb.watch',
]);

export function isFacebookUrl(url: string): boolean {
  try {
    return FACEBOOK_HOSTNAMES.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

export type FacebookPost = {
  caption: string;
  authorName: string | null;
  imageUrl: string | null;
};

/** Leading engagement summary, e.g. "88K views · 1.2K reactions | " */
const ENGAGEMENT_PREFIX =
  /^(?:[\d.,]+[KMB]?\s+(?:views|reactions|likes|comments|shares)\s*(?:·\s*)?)+\|\s*/i;

/**
 * Pulls the caption, author and cover image out of a logged-out Facebook post
 * page. Returns null when the page carries no usable caption (login
 * interstitial, deleted post, unsupported post type).
 */
export function extractFacebookPost(html: string): FacebookPost | null {
  const rawTitle = extractMetaContent(html, 'og:title');
  if (!rawTitle) return null;

  let text = decodeHtmlEntities(rawTitle).trim();
  text = text.replace(ENGAGEMENT_PREFIX, '');

  // Facebook appends " | <author>" to the title. Captions can contain pipes
  // too, so only treat the final short segment as the author.
  let authorName: string | null = null;
  const lastPipe = text.lastIndexOf(' | ');
  if (lastPipe !== -1) {
    const tail = text.slice(lastPipe + 3).trim();
    if (tail.length > 0 && tail.length <= 80 && !/\n/.test(tail)) {
      authorName = tail;
      text = text.slice(0, lastPipe);
    }
  }

  const caption = text.trim();
  if (!caption || caption === 'Facebook' || /^log in(to| or sign up)/i.test(caption)) {
    return null;
  }

  const rawImage = extractMetaContent(html, 'og:image');

  return {
    caption,
    authorName,
    imageUrl: rawImage ? decodeHtmlEntities(rawImage) : null,
  };
}
