# Feed Me Recipes

Create Anylist recipes from Instagram recipe posts.

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

# Test
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
| `PORT` | Server port (default: 3000) |

### Apify Token Permissions

Create a scoped token at [Apify Console → Settings → Integrations](https://console.apify.com/settings/integrations):

- **Actor:** `nH2AHrwxeTRJoN5hX` (apify/instagram-post-scraper)
  - Run permission

No dataset permissions required (uses sync API).

## Project Structure

```
├── src/
│   ├── index.ts      # Express server + routes
│   ├── apify.ts      # Instagram fetching (Apify sync API)
│   ├── parser.ts     # Claude Haiku recipe parsing
│   ├── anylist.ts    # AnyList recipe creation
│   └── notify.ts     # ntfy.sh notifications
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

## Recipe Parsing

Claude Haiku extracts structured recipe data from Instagram captions:

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
