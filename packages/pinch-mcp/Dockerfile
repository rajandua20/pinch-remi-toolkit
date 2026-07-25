# pinch-mcp — hardened container for the hosted multi-tenant HTTP endpoint.
#
# Pinned to major.minor; for production deploys pin to a digest, e.g.
#   FROM node:22.22-slim@sha256:<digest>
# (resolve with `docker pull node:22.22-slim && docker inspect --format='{{index .RepoDigests 0}}' node:22.22-slim`)

FROM node:22.22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22.22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json README.md SECURITY.md ./

# Never run as root — the official image ships a non-root `node` user.
USER node

# Cloud Run injects the port to listen on via $PORT (default 8080). Honour it —
# a hardcoded port fails the startup probe if the platform assigns a different
# one, which surfaces as a Google "404 / that's all we know" (no serving
# revision). Shell form so ${PORT} is expanded at runtime.
ENV PORT=8080
EXPOSE 8080

# Public playground posture: CORS on, sandbox-only (live env refused because
# --allow-live is NOT passed), per-request header credentials, no env creds
# baked in (.dockerignore excludes .env). Rate limit tunable via
# PINCH_MCP_RATE_LIMIT (requests/min/IP, default 60).
CMD ["sh", "-c", "node dist/index.js --http ${PORT:-8080} --cors"]
