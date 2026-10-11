# PolyGuide: the built web app and the API on one port (8080), as the VIScon reverse proxy expects.
FROM node:24-slim

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@12.10.1 --activate

# Dependencies first (cached while only source changes).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/routing/package.json packages/routing/
COPY scripts/package.json scripts/
RUN pnpm install --frozen-lockfile

COPY . .
# Production bundle of the web app (served by the API server with SERVE_WEB=1).
RUN pnpm -C apps/web exec vite build

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    SERVE_WEB=1 \
    TRUST_PROXY=1
EXPOSE 8080

WORKDIR /app/apps/server
CMD ["node", "node_modules/tsx/dist/cli.mjs", "src/index.ts"]
