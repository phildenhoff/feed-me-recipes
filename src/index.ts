import "dotenv/config";
import express, { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { fetchInstagramPost, getPostImageUrl, downloadImage } from "./apify.js";
import {
  parseRecipe,
  parseRecipeFromJsonLdAndCaption,
  type Recipe,
} from "./parser.js";
import { fetchHtml, extractJsonLd } from "./url-fetcher.js";
import { createRecipe, type AnyListCredentials } from "./anylist.js";
import { notifySuccess, notifyError, notifyNotRecipe } from "./notify.js";
import Database from "better-sqlite3";

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
const SQLITE_DB_PATH = process.env.SQLITE_DB_PATH;

// Validate required env vars
const requiredEnvVars = {
  API_TOKEN,
  APIFY_TOKEN,
  ANYLIST_EMAIL,
  ANYLIST_PASSWORD,
  ANTHROPIC_API_KEY,
  NTFY_TOPIC,
  SQLITE_DB_PATH,
};

for (const [name, value] of Object.entries(requiredEnvVars)) {
  if (!value) {
    console.error(`ERROR: ${name} environment variable is required`);
    process.exit(1);
  }
}

const db = new Database(SQLITE_DB_PATH);
// WAL mode is recommended by better-sqlite3
db.pragma("journal_mode = WAL");

// Create DB table, if missing
const setup_migration = db.exec(`
CREATE TABLE IF NOT EXISTS import_attempts(
      url text UNIQUE NOT NULL,
      attempts_count integer NOT NULL DEFAULT 0,
      requested_at TEXT NOT NULL, -- ISO 8601
      imported_at TEXT -- ISO 8601
);
`);

const insert_ingested_url = db.prepare(
  "INSERT INTO import_attempts (url, requested_at) VALUES (@url, @now)",
);

const get_by_url = db.prepare(
  "SELECT * FROM import_attempts WHERE url = @url;",
);

const update_count_for_url = db.prepare(`
  UPDATE import_attempts 
  SET attempts_count = attempts_count + 1 
  WHERE url = @url RETURNING url, attempts_count;
`);

const update_imported_at_for_url = db.prepare(`
    UPDATE import_attempts 
  SET imported_at = @now
  WHERE url = @url RETURNING url, attempts_count, imported_at;
  `);

const anylistCredentials: AnyListCredentials = {
  email: ANYLIST_EMAIL!,
  password: ANYLIST_PASSWORD!,
};

// Auth middleware
function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing Authorization header" });
    return;
  }

  const token = authHeader.slice(7);
  if (token !== API_TOKEN) {
    res.status(401).json({ error: "Invalid API token" });
    return;
  }

  next();
}

// Request validation
const IngestRequestSchema = z.object({
  url: z
    .string()
    .url()
    .refine((url) => url.includes("instagram.com"), {
      message: "URL must be an Instagram URL",
    }),
});

// Health check (no auth)
app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

// Ingest endpoint
app.post("/ingest", requireAuth, async (req: Request, res: Response) => {
  const parsed = IngestRequestSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid request",
      details: parsed.error.issues,
    });
    return;
  }

  const { url } = parsed.data;
  console.log(`[ingest] Received URL: ${url}`);

  const insertUrl = db.transaction((url: string, now: string) => {
    insert_ingested_url.run({ url, now });
  });
  insertUrl(url, new Date().toISOString());

  // Return 202 immediately, process async
  res.status(202).json({
    status: "processing",
    message: "Recipe ingestion started",
  });

  // Process in background
  processRecipe(url).catch((error) => {
    console.error("[ingest] Unhandled error in processRecipe:", error);
  });
});

function extractUrlFromCaption(caption: string): string | null {
  // Collapse line-broken URLs (e.g. "https://example.com/foo\nbar/")
  const normalized = caption.replace(/\n(?=\S)/g, "");
  // Match both protocol-prefixed URLs and bare www. URLs (e.g. "www.example.com/path")
  const match = normalized.match(
    /(?:https?:\/\/|www\.)(?!(?:www\.)?instagram\.com)[^\s]+/i,
  );
  if (!match) return null;
  // Strip trailing punctuation that may be part of surrounding text
  const url = match[0].replace(/[.,)>\]]+$/, "");
  // Ensure the URL has a protocol
  return url.startsWith("http") ? url : `https://${url}`;
}

/**
 * Fetches a URL and returns the Schema.org Recipe JSON-LD object, or null on any
 * failure (network error, no JSON-LD, wrong @type, etc.).
 *
 * Kept as a standalone helper so callers never have to worry about error handling —
 * a missing or unreachable URL is always a graceful degradation, not a hard failure.
 */
async function tryFetchJsonLd(
  url: string,
): Promise<Record<string, unknown> | null> {
  try {
    const html = await fetchHtml(url);
    return extractJsonLd(html);
  } catch (err) {
    console.warn(
      `[process] Failed to fetch JSON-LD from ${url}: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}

async function processRecipe(url: string): Promise<void> {
  console.log(`[process] Starting recipe processing for: ${url}`);

  try {
    const updateAttemptCount = db.transaction((url: string) => {
      update_count_for_url.run({ url });
    });
    updateAttemptCount(url);

    // Step 1: Fetch Instagram post
    console.log("[process] Step 1: Fetching Instagram post...");
    const post = await fetchInstagramPost(url, APIFY_TOKEN!);
    console.log(
      `[process] Got post from @${post.ownerUsername}: ${post.caption.slice(0, 100)}...`,
    );

    let recipe: Recipe;
    let recipeSourceUrl = url;

    // Step 2: Extract recipe
    //
    // Strategy: always check the caption for a linked recipe URL and prefer its
    // Schema.org JSON-LD over asking Haiku to parse the caption alone. Reasons:
    //
    // 1. Haiku hallucination has no reliable output-side detector. When a caption
    //    gives only a vague ingredient list ("olive oil, garlic, pasta"), Haiku
    //    invents plausible quantities rather than admitting it doesn't know. A
    //    single invented value defeats any field-presence check — the previous
    //    isThinRecipe() heuristic (flag if every ingredient lacks a quantity) fails
    //    the moment Haiku writes "1 tsp" for salt.
    //
    // 2. JSON-LD is the recipe site's own machine-readable data: exact weights,
    //    full step-by-step method, precise timings. When it exists it is the
    //    authoritative source, not an LLM's reconstruction from a caption.
    //
    // 3. We still run Haiku, but now grounded by the JSON-LD. Its role is to
    //    merge authoritative structure with the creator's own words (tips,
    //    variations, personal notes) rather than to invent structure from scratch.
    //
    // Fallback: if there is no URL, the URL is unreachable, or the page has no
    // Recipe JSON-LD, we fall back to caption-only Haiku parsing — same behaviour
    // as before, but now it is a last resort rather than the default.
    console.log("[process] Step 2: Extracting recipe...");
    const recipeUrl = extractUrlFromCaption(post.caption);
    const jsonLd = recipeUrl ? await tryFetchJsonLd(recipeUrl) : null;

    if (jsonLd) {
      console.log(
        `[process] Found JSON-LD at ${recipeUrl}, parsing with caption context...`,
      );
      const result = await parseRecipeFromJsonLdAndCaption(
        jsonLd,
        post.caption,
        ANTHROPIC_API_KEY!,
      );
      if (!result.is_recipe) {
        console.log(`[process] JSON-LD not a recipe: ${result.reason}`);
        await notifyNotRecipe(NTFY_TOPIC!, result.reason, url);
        return;
      }
      recipe = result.recipe;
      recipeSourceUrl = recipeUrl!;
      console.log(
        `[process] Parsed recipe from JSON-LD + caption: "${recipe.name}"`,
      );
    } else {
      // No JSON-LD available: no URL in caption, URL fetch failed, or the page
      // has no Recipe schema. Fall back to caption-only parsing.
      if (recipeUrl) {
        console.log(
          `[process] No JSON-LD found at ${recipeUrl}, falling back to caption...`,
        );
      }
      console.log("[process] Parsing caption with Claude...");
      const captionResult = await parseRecipe(post.caption, ANTHROPIC_API_KEY!);
      if (!captionResult.is_recipe) {
        console.log(
          `[process] Caption is not a recipe: ${captionResult.reason}`,
        );
        await notifyNotRecipe(NTFY_TOPIC!, captionResult.reason, url);
        return;
      }
      recipe = captionResult.recipe;
      console.log(
        `[process] Parsed recipe from caption: "${recipe.name}" (confidence: ${captionResult.confidence})`,
      );
    }

    // Step 3: Download cover photo (graceful degradation if fails)
    console.log("[process] Step 3: Downloading cover photo...");
    let photo: Buffer | undefined;
    const imageUrl = getPostImageUrl(post);
    if (imageUrl) {
      photo = await downloadImage(imageUrl);
      if (photo) {
        console.log(`[process] Downloaded photo: ${photo.length} bytes`);
      } else {
        console.log(
          "[process] Photo download failed, continuing without photo",
        );
      }
    } else {
      console.log("[process] No image URL found in post");
    }

    // Step 4: Create recipe in AnyList
    console.log("[process] Step 4: Creating recipe in AnyList...");
    const created = await createRecipe({
      recipe,
      sourceUrl: recipeSourceUrl,
      sourceUsername: post.ownerUsername,
      credentials: anylistCredentials,
      photo,
    });

    console.log(`[process] Recipe created: ${created.id}`);

    // Step 5: Send success notification
    console.log("[process] Step 5: Sending notification...");
    await notifySuccess(NTFY_TOPIC!, created.name, url);
    const updateImportedAt = db.transaction((url: string, now: Date) => {
      update_imported_at_for_url.run({ url, now });
    });
    updateImportedAt(url, new Date().toISOString());

    console.log("[process] Done!");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[process] Error: ${message}`);

    try {
      await notifyError(NTFY_TOPIC!, message, url);
    } catch (notifyErr) {
      console.error("[process] Failed to send error notification:", notifyErr);
    }
  }
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`ntfy topic: ${NTFY_TOPIC}`);
});
