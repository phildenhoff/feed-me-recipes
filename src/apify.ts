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

export interface InstagramPost {
  caption: string;
  ownerUsername: string;
  ownerFullName: string;
  url: string;
  shortCode: string;
  timestamp: string;
  type: string;
  hashtags: string[];
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
