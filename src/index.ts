import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { fetchInstagramPost } from './apify.js';
import { parseRecipe } from './parser.js';
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

async function processRecipe(url: string): Promise<void> {
  console.log(`[process] Starting recipe processing for: ${url}`);

  try {
    // Step 1: Fetch Instagram post
    console.log('[process] Step 1: Fetching Instagram post...');
    const post = await fetchInstagramPost(url, APIFY_TOKEN!);
    console.log(`[process] Got post from @${post.ownerUsername}: ${post.caption.slice(0, 100)}...`);

    // Step 2: Parse recipe with Claude
    console.log('[process] Step 2: Parsing recipe with Claude...');
    const parseResult = await parseRecipe(post.caption, ANTHROPIC_API_KEY!);

    if (!parseResult.is_recipe) {
      console.log(`[process] Not a recipe: ${parseResult.reason}`);
      await notifyNotRecipe(NTFY_TOPIC!, parseResult.reason, url);
      return;
    }

    console.log(`[process] Parsed recipe: "${parseResult.recipe.name}" (confidence: ${parseResult.confidence})`);

    // Step 3: Create recipe in AnyList
    console.log('[process] Step 3: Creating recipe in AnyList...');
    const created = await createRecipe(
      parseResult.recipe,
      url,
      post.ownerUsername,
      anylistCredentials
    );

    console.log(`[process] Recipe created: ${created.id}`);

    // Step 4: Send success notification
    console.log('[process] Step 4: Sending notification...');
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
