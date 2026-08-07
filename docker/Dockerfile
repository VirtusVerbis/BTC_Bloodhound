FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* tsconfig.base.json ./
COPY packages ./packages
COPY apps/indexer ./apps/indexer
COPY apps/web/package.json ./apps/web/package.json
COPY config ./config
RUN pnpm install --frozen-lockfile || pnpm install
RUN pnpm -r run build
