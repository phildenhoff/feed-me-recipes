import "dotenv/config";
import express, { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { fetchInstagramPost, getPostImageUrl, downloadImage } from "./apify.js";
import {
  parseRecipe,
  parseRecipeFromJsonLdAndCaption,
  parseRecipeFromJsonLd,
  type Recipe,
} from "./parser.js";
import { fetchHtml, extractJsonLd, extractOpenGraphImageUrl } from "./url-fetcher.js";
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

const get_failed_urls = db.prepare(`
  SELECT url, attempts_count, requested_at
  FROM import_attempts
  WHERE imported_at IS NULL AND attempts_count > 0
  ORDER BY requested_at DESC;
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
  url: z.string().url(),
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

  try {
    const insertUrl = db.transaction((url: string, now: string) => {
      insert_ingested_url.run({ url, now });
    });
    insertUrl(url, new Date().toISOString());
  } catch (err: any) {
    if (err?.code === "SQLITE_CONSTRAINT_UNIQUE") {
      res.status(200).json({ status: "ok" });
      return;
    }
    throw err;
  }

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

function isInstagramUrl(url: string): boolean {
  return url.includes("instagram.com");
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

    let recipe: Recipe;
    let recipeSourceUrl = url;
    let sourceUsername: string | undefined;
    let photo: Buffer | undefined;

    if (isInstagramUrl(url)) {
      // ── Instagram path ──────────────────────────────────────────────────────
      //
      // Step 1: Fetch Instagram post
      console.log("[process] Step 1: Fetching Instagram post...");
      const post = await fetchInstagramPost(url, APIFY_TOKEN!);
      console.log(
        `[process] Got post from @${post.ownerUsername}: ${post.caption.slice(0, 100)}...`,
      );

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

      sourceUsername = post.ownerUsername;

      // Step 3: Download cover photo (graceful degradation if fails)
      console.log("[process] Step 3: Downloading cover photo...");
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
    } else {
      // ── Direct web URL path ─────────────────────────────────────────────────
      //
      // Step 1: Fetch the recipe page
      console.log("[process] Step 1: Fetching recipe page...");
      const html = await fetchHtml(url);

      // Step 2: Extract recipe from JSON-LD structured data
      console.log("[process] Step 2: Extracting recipe from JSON-LD...");
      const jsonLd = extractJsonLd(html);

      if (!jsonLd) {
        const reason = "No Recipe JSON-LD found on page";
        console.log(`[process] ${reason}`);
        await notifyNotRecipe(NTFY_TOPIC!, reason, url);
        return;
      }

      const result = await parseRecipeFromJsonLd(jsonLd, ANTHROPIC_API_KEY!);
      if (!result.is_recipe) {
        console.log(`[process] Not a recipe: ${result.reason}`);
        await notifyNotRecipe(NTFY_TOPIC!, result.reason, url);
        return;
      }
      recipe = result.recipe;
      console.log(`[process] Parsed recipe: "${recipe.name}"`);

      // Step 3: Download cover image from OpenGraph metadata (graceful degradation if fails)
      console.log("[process] Step 3: Extracting cover image...");
      const openGraphImageUrl = extractOpenGraphImageUrl(html);
      if (openGraphImageUrl) {
        photo = await downloadImage(openGraphImageUrl);
        if (photo) {
          console.log(`[process] Downloaded OpenGraph image: ${photo.length} bytes`);
        } else {
          console.log(
            "[process] OpenGraph image download failed, continuing without photo",
          );
        }
      } else {
        console.log("[process] No OpenGraph image found, continuing without photo");
      }
    }

    // Step 4: Create recipe in AnyList
    console.log("[process] Step 4: Creating recipe in AnyList...");
    const created = await createRecipe({
      recipe,
      sourceUrl: recipeSourceUrl,
      sourceUsername,
      credentials: anylistCredentials,
      photo,
    });

    console.log(`[process] Recipe created: ${created.id}`);

    // Step 5: Send success notification
    console.log("[process] Step 5: Sending notification...");
    await notifySuccess(NTFY_TOPIC!, created.name, url);
    const updateImportedAt = db.transaction((url: string, now: Date) => {
      update_imported_at_for_url.run({ url, now: now.toISOString() });
    });
    updateImportedAt(url, new Date());

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

// Admin server (Tailscale-only, port 3001)
const ADMIN_PORT = Number(process.env.ADMIN_PORT) || 3001;
const adminApp = express();
adminApp.use(express.json());

adminApp.get("/", (_req: Request, res: Response) => {
  const failed = get_failed_urls.all() as {
    url: string;
    attempts_count: number;
    requested_at: string;
  }[];

  const rows = failed
    .map(
      ({ url, attempts_count, requested_at }) => `
      <tr>
        <td><a href="${url}" target="_blank">${url}</a></td>
        <td>${attempts_count}</td>
        <td>${new Date(requested_at).toLocaleString()}</td>
        <td>
          <form method="POST" action="/retry">
            <input type="hidden" name="url" value="${url}" />
            <button type="submit">Retry</button>
          </form>
        </td>
      </tr>`,
    )
    .join("");

  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>fmr admin</title>
  <style>
    body { font-family: monospace; padding: 2rem; }
    table { border-collapse: collapse; width: 100%; }
    th, td { text-align: left; padding: 0.5rem 1rem; border-bottom: 1px solid #ddd; }
    th { background: #f5f5f5; }
    a { color: inherit; }
    button { cursor: pointer; }
  </style>
</head>
<body>
  <h1>Failed imports (${failed.length})</h1>
  ${
    failed.length === 0
      ? "<p>No failures.</p>"
      : `<table>
    <thead><tr><th>URL</th><th>Attempts</th><th>Requested</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <br />
  <form method="POST" action="/retry">
    <input type="hidden" name="all" value="true" />
    <button type="submit">Retry all (${failed.length})</button>
  </form>`
  }
</body>
</html>`);
});

adminApp.post("/retry", express.urlencoded({ extended: false }), (req: Request, res: Response) => {
  const { url, all } = req.body as { url?: string; all?: string };

  if (all === "true") {
    const failed = get_failed_urls.all() as { url: string }[];
    for (const { url } of failed) {
      processRecipe(url).catch((err) =>
        console.error(`[admin] Unhandled error retrying ${url}:`, err),
      );
    }
    console.log(`[admin] Retrying all ${failed.length} failed URLs`);
    res.redirect("/");
    return;
  }

  if (!url) {
    res.status(400).send("Missing url");
    return;
  }

  processRecipe(url).catch((err) =>
    console.error(`[admin] Unhandled error retrying ${url}:`, err),
  );
  console.log(`[admin] Retrying ${url}`);
  res.redirect("/");
});

adminApp.listen(ADMIN_PORT, () => {
  console.log(`Admin server running on port ${ADMIN_PORT}`);
});
