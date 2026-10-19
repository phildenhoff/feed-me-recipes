# Feed Me Recipes

Create AnyList recipes from Instagram posts, Facebook posts, and recipe websites.

## How It Works

```
iOS Shortcut
     ↓
POST /ingest { "url": "https://instagram.com/p/..." }
     ↓
┌─────────────────────────────────────────┐
│  Recipe Ingest Service (Docker)         │
│                                         │
│  1. Validate bearer token               │
│  2. Fetch post via Apify                │
│  3. Parse recipe with Claude Haiku      │
│  4. Create recipe in AnyList            │
│  5. Send push notification via ntfy.sh  │
└─────────────────────────────────────────┘
```

## Quick Start

```bash
# Install dependencies
pnpm install

# Copy and configure environment
cp .env.example .env
# Edit .env with your credentials

# Run locally
pnpm dev

# Test (unit)
pnpm test

# Try it
curl -X POST http://localhost:3000/ingest \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.instagram.com/p/ABC123/"}'
```

## API

### POST /ingest

Accepts an Instagram URL and processes it into a recipe.

**Request:**
```http
POST /ingest HTTP/1.1
Authorization: Bearer <API_TOKEN>
Content-Type: application/json

{
  "url": "https://www.instagram.com/p/ABC123/"
}
```

**Response:**
```http
HTTP/1.1 202 Accepted

{
  "status": "processing",
  "message": "Recipe ingestion started"
}
```

### GET /health

Health check (no auth required).

```http
HTTP/1.1 200 OK
{"status": "ok"}
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `API_TOKEN` | Bearer token for authenticating requests |
| `APIFY_TOKEN` | Apify API token for Instagram scraping |
| `ANYLIST_EMAIL` | AnyList account email |
| `ANYLIST_PASSWORD` | AnyList account password |
| `ANTHROPIC_API_KEY` | Claude API key for recipe parsing |
| `NTFY_TOPIC` | ntfy.sh topic for notifications |
| `SQLITE_DB_PATH` | Path to the SQLite database tracking import attempts |
| `JINA_API_KEY` | Optional. Jina Reader key for the bot-blocked-site fallback (higher rate limits) |
| `PORT` | Server port (default: 3000) |
| `ADMIN_PORT` | Tailscale-only admin UI port (default: 3001) |

### Apify Token Permissions

Create a scoped token at [Apify Console → Settings → Integrations](https://console.apify.com/settings/integrations):

- **Actor:** `nH2AHrwxeTRJoN5hX` (apify/instagram-post-scraper)
  - Run permission

No dataset permissions required (uses sync API).

## Project Structure

```
├── src/
│   ├── index.ts             # Express server + routes + admin retry UI
│   ├── recipe-extractor.ts  # Picks a source strategy (Instagram / Facebook / URL)
│   ├── apify.ts             # Instagram fetching (Apify sync API)
│   ├── facebook.ts          # Facebook post caption extraction (OpenGraph tags)
│   ├── url-fetcher.ts       # HTML fetching with bot-block fallback, JSON-LD extraction
│   ├── parser.ts            # Claude Haiku recipe parsing
│   ├── anylist.ts           # AnyList recipe creation
│   └── notify.ts            # ntfy.sh notifications
├── scripts/
│   └── postinstall.js  # Patches anylist-napi ESM bug
├── Dockerfile
├── package.json
└── tsconfig.json
```

## Deployment

### Docker

```bash
docker build -t feed-me-recipe .

docker run -d \
  --name feed-me-recipe \
  --env-file .env \
  -p 3000:3000 \
  feed-me-recipe
```

### Recommended: Cloudflare Tunnel

Expose the service securely without opening ports:

1. Create tunnel in [Cloudflare Zero Trust dashboard](https://one.dash.cloudflare.com/)
2. Add public hostname pointing to `http://localhost:3000`
3. Optionally configure Zero Trust access policies (or rely on bearer token auth)

## Supported Sources

| URL | How it is read |
|-----|----------------|
| `instagram.com/...` | Post fetched via Apify. If the caption links to a recipe site, that site's JSON-LD is merged with the caption. |
| `facebook.com/share/...`, `fb.watch/...` | Logged-out post page fetched directly; the full caption comes from the `og:title` tag (`og:description` is truncated). Same caption/JSON-LD merge as Instagram. |
| Any other URL | Page fetched directly and its Schema.org Recipe JSON-LD parsed. |

### Bot protection

Pages are requested with an honest `FeedMeRecipes/1.0` User-Agent. Do not
"fix" a 403 by spoofing a browser User-Agent: Cloudflare and Facebook flag a
Chrome User-Agent arriving without Chrome's TLS fingerprint and client-hint
headers, and reject it. The honest User-Agent is what gets through.

If a site still answers 401/403/406/429/503, the fetch is retried through the
[Jina Reader](https://r.jina.ai) proxy, which renders the page in a real
browser. That clears PerimeterX (thekitchn.com) and lighter Cloudflare rules.
Sites behind a full Cloudflare managed challenge (for example jenniabs.com)
fail both tiers; the error notification then says the site blocks automated
requests so you know to share the recipe text another way.

## Recipe Parsing

Claude Haiku extracts structured recipe data from post captions and JSON-LD:

```json
{
  "is_recipe": true,
  "confidence": 0.95,
  "recipe": {
    "name": "Sheet Pan Beef Kefta Wraps",
    "servings": "4 servings",
    "prepTime": 20,
    "cookTime": 15,
    "ingredients": [
      {"name": "ground beef", "quantity": "1.5 lbs"},
      {"name": "garlic", "quantity": "8 cloves", "note": "minced"}
    ],
    "steps": [
      "Preheat oven to 400°F...",
      "Mix beef with spices..."
    ]
  }
}
```

Posts without recipes return `{"is_recipe": false, "reason": "..."}`.

## Known Issues

- `anylist-napi` prepTime/cookTime values save as 0 (upstream bug)

## Future Improvements

- [ ] Confidence threshold → flag low-confidence for manual review
- [ ] Job queue for reliability
- [ ] Recipe deduplication
- [ ] Web UI for review/edit
- [ ] Multi-user support
