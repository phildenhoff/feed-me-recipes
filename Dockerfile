# =========================
# Builder stage
# =========================
FROM node:20-slim AS builder

WORKDIR /app

# ---- Install minimal tools ONLY to satisfy installers ----
# We deliberately do NOT install full build-essential,
# because we want to fail if a prebuilt binary is missing.
RUN apt-get update && apt-get install -y \
    ca-certificates \
    curl \
    python3 \
    && rm -rf /var/lib/apt/lists/*

# ---- pnpm ----
RUN corepack enable && corepack prepare pnpm@latest --activate

# ---- Force native addons to use prebuilt binaries only ----
# These env vars are respected by napi-rs / node-gyp ecosystems
ENV npm_config_build_from_source=false
ENV npm_config_fallback_to_build=false
ENV NAPI_RS_NO_BUILD=1

COPY package.json pnpm-lock.yaml* ./

RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src

RUN pnpm build

# ---- Prune dev deps so runtime is smaller ----
RUN pnpm prune --prod


# =========================
# Runtime stage
# =========================
FROM node:20-slim

WORKDIR /app

# ---- Copy runtime artifacts ----
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "dist/index.js"]
