FROM node:24-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/flight-worker/package.json ./apps/flight-worker/package.json
COPY patches ./patches
COPY packages/conversation-core/package.json ./packages/conversation-core/package.json
COPY packages/flight-domain/package.json ./packages/flight-domain/package.json
COPY packages/flight-store/package.json ./packages/flight-store/package.json
COPY packages/observability/package.json ./packages/observability/package.json
COPY packages/provider-duffel/package.json ./packages/provider-duffel/package.json
COPY packages/telegram-core/package.json ./packages/telegram-core/package.json
RUN pnpm install --frozen-lockfile --prod

COPY apps/flight-worker ./apps/flight-worker
COPY packages/flight-domain ./packages/flight-domain
COPY packages/flight-store ./packages/flight-store
COPY packages/observability ./packages/observability
COPY packages/provider-duffel ./packages/provider-duffel

WORKDIR /app/apps/flight-worker
CMD ["node", "--import", "tsx", "src/index.ts"]
