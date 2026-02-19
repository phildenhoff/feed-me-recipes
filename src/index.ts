import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { fetchInstagramPost, getPostImageUrl, downloadImage } from './apify.js';
import { parseRecipe, parseRecipeFromJsonLd, type Recipe } from './parser.js';
import { fetchHtml, extractJsonLd } from './url-fetcher.js';
import { createRecipe, type AnyListCredentials } from './anylist.js';
import { notifySuccess, notifyError, notifyNotRecipe } from './notify.js';

const app = express();
app.use(express.json());

// Environment variables
const PORT = process.env.PORT || 3000;
const API_TOKEN = process.env.API_TOKEN;
const APIFY_TOKEN = process.env.APIFY_TOKEN;
const ANYLIST_EMAIL = process.env.ANYLIST_EMAIL;
const ANYLIST_PASSWORD = process.env.ANYLIST_PASSWORD;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const NTFY_TOPIC = process.env.NTFY_TOPIC;

// Validate required env vars
const requiredEnvVars = {
  API_TOKEN,
  APIFY_TOKEN,
  ANYLIST_EMAIL,
  ANYLIST_PASSWORD,
  ANTHROPIC_API_KEY,
  NTFY_TOPIC,
};

for (const [name, value] of Object.entries(requiredEnvVars)) {
  if (!value) {
    console.error(`ERROR: ${name} environment variable is required`);
    process.exit(1);
  }
}

const anylistCredentials: AnyListCredentials = {
  email: ANYLIST_EMAIL!,
  password: ANYLIST_PASSWORD!,
};

// Auth middleware
function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing Authorization header' });
    return;
  }

  const token = authHeader.slice(7);
  if (token !== API_TOKEN) {
    res.status(401).json({ error: 'Invalid API token' });
    return;
  }

  next();
}

// Request validation
const IngestRequestSchema = z.object({
  url: z.string().url().refine(
    (url) => url.includes('instagram.com'),
    { message: 'URL must be an Instagram URL' }
  ),
});

// Health check (no auth)
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

// Ingest endpoint
app.post('/ingest', requireAuth, async (req: Request, res: Response) => {
  const parsed = IngestRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'Invalid request',
      details: parsed.error.issues
    });
    return;
  }

  const { url } = parsed.data;
  console.log(`[ingest] Received URL: ${url}`);

  // Return 202 immediately, process async
  res.status(202).json({
    status: 'processing',
    message: 'Recipe ingestion started'
  });

  // Process in background
  processRecipe(url).catch((error) => {
    console.error('[ingest] Unhandled error in processRecipe:', error);
  });
});

function extractUrlFromCaption(caption: string): string | null {
  // Collapse line-broken URLs (e.g. "https://example.com/foo\nbar/")
  const normalized = caption.replace(/\n(?=\S)/g, '');
  const match = normalized.match(
    /https?:\/\/(?!(?:www\.)?instagram\.com)[^\s]+/i
  );
  if (!match) return null;
  // Strip trailing punctuation that may be part of surrounding text
  return match[0].replace(/[.,)>\]]+$/, '');
}

/** Returns true when a caption-extracted recipe has no steps or no quantities — suggesting
 *  the caption only described ingredients in passing rather than giving a full recipe. */
function isThinRecipe(recipe: Recipe): boolean {
  const hasNoSteps = recipe.steps.length === 0;
  const hasNoQuantities = recipe.ingredients.every((i) => !i.quantity);
  return hasNoSteps || hasNoQuantities;
}

/** Best-effort attempt to fetch a full recipe from a URL. Returns null on any failure. */
async function tryFetchRecipeFromUrl(
  recipeUrl: string,
  anthropicApiKey: string
): Promise<Recipe | null> {
  try {
    const html = await fetchHtml(recipeUrl);
    const jsonLd = extractJsonLd(html);
    if (!jsonLd) return null;

    const result = await parseRecipeFromJsonLd(jsonLd, anthropicApiKey);
    return result.is_recipe ? result.recipe : null;
  } catch (err) {
    console.warn(`[process] URL recipe fetch failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

async function processRecipe(url: string): Promise<void> {
  console.log(`[process] Starting recipe processing for: ${url}`);

  try {
    // Step 1: Fetch Instagram post
    console.log('[process] Step 1: Fetching Instagram post...');
    const post = await fetchInstagramPost(url, APIFY_TOKEN!);
    console.log(`[process] Got post from @${post.ownerUsername}: ${post.caption.slice(0, 100)}...`);

    // Step 2: Parse recipe with Claude Haiku (primary path)
    console.log('[process] Step 2: Parsing caption with Claude...');
    const captionResult = await parseRecipe(post.caption, ANTHROPIC_API_KEY!);

    let recipe: Recipe;
    let recipeSourceUrl = url;

    if (!captionResult.is_recipe) {
      // Step 2b: Caption has no recipe — attempt URL fallback
      console.log(`[process] Caption is not a recipe: ${captionResult.reason}`);
      const recipeUrl = extractUrlFromCaption(post.caption);

      if (!recipeUrl) {
        console.log('[process] No recipe URL found in caption');
        await notifyNotRecipe(NTFY_TOPIC!, captionResult.reason, url);
        return;
      }

      console.log(`[process] Attempting URL fallback: ${recipeUrl}`);
      const html = await fetchHtml(recipeUrl); // throws on network/HTTP error → notifyError

      const jsonLd = extractJsonLd(html);
      if (!jsonLd) {
        throw new Error(`No Schema.org Recipe data found at ${recipeUrl}`);
      }

      const urlResult = await parseRecipeFromJsonLd(jsonLd, ANTHROPIC_API_KEY!);
      if (!urlResult.is_recipe) {
        console.log(`[process] URL recipe not parseable: ${urlResult.reason}`);
        await notifyNotRecipe(NTFY_TOPIC!, urlResult.reason, url);
        return;
      }

      recipe = urlResult.recipe;
      recipeSourceUrl = recipeUrl;
      console.log(`[process] Parsed recipe from URL: "${recipe.name}"`);
    } else {
      recipe = captionResult.recipe;
      console.log(`[process] Parsed recipe from caption: "${recipe.name}" (confidence: ${captionResult.confidence})`);

      // Step 2c: Caption recipe looks thin (ingredients only, no steps or quantities) —
      // try the URL as a best-effort upgrade, but keep the caption result if it fails.
      if (isThinRecipe(recipe)) {
        const recipeUrl = extractUrlFromCaption(post.caption);
        if (recipeUrl) {
          console.log(`[process] Caption recipe is thin, attempting URL upgrade: ${recipeUrl}`);
          const urlRecipe = await tryFetchRecipeFromUrl(recipeUrl, ANTHROPIC_API_KEY!);
          if (urlRecipe) {
            recipe = urlRecipe;
            recipeSourceUrl = recipeUrl;
            console.log(`[process] Upgraded to URL recipe: "${recipe.name}"`);
          } else {
            console.log('[process] URL upgrade failed, using caption recipe');
          }
        }
      }
    }

    // Step 3: Download cover photo (graceful degradation if fails)
    console.log('[process] Step 3: Downloading cover photo...');
    let photo: Buffer | undefined;
    const imageUrl = getPostImageUrl(post);
    if (imageUrl) {
      photo = await downloadImage(imageUrl);
      if (photo) {
        console.log(`[process] Downloaded photo: ${photo.length} bytes`);
      } else {
        console.log('[process] Photo download failed, continuing without photo');
      }
    } else {
      console.log('[process] No image URL found in post');
    }

    // Step 4: Create recipe in AnyList
    console.log('[process] Step 4: Creating recipe in AnyList...');
    const created = await createRecipe({
      recipe,
      sourceUrl: recipeSourceUrl,
      sourceUsername: post.ownerUsername,
      credentials: anylistCredentials,
      photo,
    });

    console.log(`[process] Recipe created: ${created.id}`);

    // Step 5: Send success notification
    console.log('[process] Step 5: Sending notification...');
    await notifySuccess(NTFY_TOPIC!, created.name, url);

    console.log('[process] Done!');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[process] Error: ${message}`);

    try {
      await notifyError(NTFY_TOPIC!, message, url);
    } catch (notifyErr) {
      console.error('[process] Failed to send error notification:', notifyErr);
    }
  }
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`ntfy topic: ${NTFY_TOPIC}`);
});
