/**
 * Apify Instagram Post Scraper integration
 * Uses the sync endpoint which runs the actor and returns results directly.
 *
 * Token permissions required:
 * - Actor: nH2AHrwxeTRJoN5hX (Run)
 *
 * No dataset permissions needed - results returned inline.
 */

const ACTOR_ID = 'nH2AHrwxeTRJoN5hX'; // apify/instagram-post-scraper
const APIFY_BASE = 'https://api.apify.com/v2';

export interface InstagramImage {
  displayUrl: string;
}

export interface InstagramPost {
  caption: string;
  ownerUsername: string;
  ownerFullName: string;
  url: string;
  shortCode: string;
  timestamp: string;
  type: 'Photo' | 'Sidecar' | 'Video' | string;
  hashtags: string[];
  // Image fields from Apify
  displayUrl?: string;
  thumbnailUrl?: string;
  images?: InstagramImage[];
}

/**
 * Get the best cover image URL from an Instagram post.
 * - Photo: displayUrl
 * - Sidecar (carousel): first image's displayUrl
 * - Video: thumbnailUrl
 */
export function getPostImageUrl(post: InstagramPost): string | undefined {
  // For carousels, use the first image
  if (post.type === 'Sidecar' && post.images && post.images.length > 0) {
    return post.images[0].displayUrl;
  }

  // For videos, use thumbnail
  if (post.type === 'Video' && post.thumbnailUrl) {
    return post.thumbnailUrl;
  }

  // For photos or fallback, use displayUrl
  return post.displayUrl;
}

export async function fetchInstagramPost(
  url: string,
  apifyToken: string
): Promise<InstagramPost> {
  console.log(`[apify] Fetching post (sync): ${url}`);

  // Use sync endpoint - runs actor and returns dataset items directly
  // Timeout: 300 seconds (5 minutes)
  const response = await fetch(
    `${APIFY_BASE}/acts/${ACTOR_ID}/run-sync-get-dataset-items?token=${apifyToken}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: [url],
        resultsLimit: 1,
      }),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Apify sync run failed: ${response.status} - ${error}`);
  }

  const results: InstagramPost[] = await response.json();

  if (results.length === 0) {
    throw new Error('No results returned from Apify');
  }

  console.log(`[apify] Got post from @${results[0].ownerUsername}`);
  return results[0];
}

/**
 * Download an image from a URL and return it as a Buffer.
 * Returns undefined if the download fails (for graceful degradation).
 */
export async function downloadImage(imageUrl: string): Promise<Buffer | undefined> {
  console.log(`[apify] Downloading image: ${imageUrl.slice(0, 80)}...`);

  try {
    const response = await fetch(imageUrl);

    if (!response.ok) {
      console.warn(`[apify] Image download failed: ${response.status}`);
      return undefined;
    }

    const contentType = response.headers.get('content-type');
    if (!contentType?.startsWith('image/')) {
      console.warn(`[apify] Unexpected content type: ${contentType}`);
      return undefined;
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    console.log(`[apify] Downloaded image: ${buffer.length} bytes`);
    return buffer;
  } catch (error) {
    console.warn(`[apify] Image download error: ${error instanceof Error ? error.message : error}`);
    return undefined;
  }
}
