# pinch-mcp — multi-tenant hosted MCP server
# Build:  docker build -t pinch-mcp .
# Run:    docker run -p 8080:8080 pinch-mcp
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm install
COPY src ./src
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# Multi-tenant mode: NO credentials in env — each request brings its own via
# x-pinch-merchant-id / x-pinch-secret-key headers. Live env stays refused
# (never add --allow-live on a shared/public endpoint).
# Cloud Run injects PORT; default 8080 elsewhere.
CMD ["sh", "-c", "node dist/index.js --http ${PORT:-8080} --cors"]
