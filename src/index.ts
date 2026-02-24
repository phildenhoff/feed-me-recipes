import "dotenv/config";
import express, { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { fetchInstagramPost, getPostImageUrl, downloadImage } from "./apify.js";
import {
  parseRecipe,
  parseRecipeFromJsonLdAndCaption,
  parseRecipeFromJsonLd,
} from "./parser.js";
import { fetchHtml, extractJsonLd, extractOpenGraphImageUrl } from "./url-fetcher.js";
import { createRecipe, type AnyListCredentials } from "./anylist.js";
import { notifySuccess, notifyError, notifyNotRecipe } from "./notify.js";
import { extractRecipeFromSource, type ExtractionDeps } from "./recipe-extractor.js";
import Database from "better-sqlite3";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_TOKEN = process.env.API_TOKEN;
const APIFY_TOKEN = process.env.APIFY_TOKEN;
const ANYLIST_EMAIL = process.env.ANYLIST_EMAIL;
const ANYLIST_PASSWORD = process.env.ANYLIST_PASSWORD;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const NTFY_TOPIC = process.env.NTFY_TOPIC;
const SQLITE_DB_PATH = process.env.SQLITE_DB_PATH;

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

const IngestRequestSchema = z.object({
  url: z.string().url(),
});

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

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

  res.status(202).json({
    status: "processing",
    message: "Recipe ingestion started",
  });

  processRecipe(url).catch((error) => {
    console.error("[ingest] Unhandled error in processRecipe:", error);
  });
});

async function processRecipe(url: string): Promise<void> {
  console.log(`[process] Starting: ${url}`);

  try {
    update_count_for_url.run({ url });

    const deps: ExtractionDeps = {
      fetchInstagramPost: (u) => fetchInstagramPost(u, APIFY_TOKEN!),
      getPostImageUrl,
      downloadImage,
      fetchHtml,
      extractJsonLd,
      extractOpenGraphImageUrl,
      parseRecipeFromCaption: (caption) => parseRecipe(caption, ANTHROPIC_API_KEY!),
      parseRecipeFromJsonLd: (jsonLd) => parseRecipeFromJsonLd(jsonLd, ANTHROPIC_API_KEY!),
      parseRecipeFromJsonLdAndCaption: (jsonLd, caption) =>
        parseRecipeFromJsonLdAndCaption(jsonLd, caption, ANTHROPIC_API_KEY!),
    };

    const result = await extractRecipeFromSource(url, deps);

    if (!result.ok) {
      console.log(`[process] Not a recipe: ${result.reason}`);
      await notifyNotRecipe(NTFY_TOPIC!, result.reason, url);
      return;
    }

    const { recipe, sourceUrl, sourceName, photo } = result.value;

    const created = await createRecipe({
      recipe,
      sourceUrl,
      sourceName,
      credentials: anylistCredentials,
      photo,
    });

    console.log(`[process] Created: ${created.name}`);
    await notifySuccess(NTFY_TOPIC!, created.name, url);
    update_imported_at_for_url.run({ url, now: new Date().toISOString() });
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
