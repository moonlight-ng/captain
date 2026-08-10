FROM node:24-bookworm-slim AS build

WORKDIR /app
ENV CI=true
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web/package.json ./apps/web/package.json
COPY apps/captain/package.json ./apps/captain/package.json
COPY packages/flight-domain/package.json ./packages/flight-domain/package.json
COPY packages/flight-store/package.json ./packages/flight-store/package.json
COPY packages/observability/package.json ./packages/observability/package.json
COPY packages/provider-duffel/package.json ./packages/provider-duffel/package.json
COPY packages/telegram-core/package.json ./packages/telegram-core/package.json
RUN pnpm install --frozen-lockfile

COPY apps/web ./apps/web
COPY apps/captain ./apps/captain
COPY packages ./packages
WORKDIR /app/apps/captain
RUN pnpm build

FROM node:24-bookworm-slim AS runtime

WORKDIR /app/apps/captain
ENV NODE_ENV=production
ENV PATH="/app/apps/captain/node_modules/.bin:/app/node_modules/.bin:${PATH}"
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/apps/captain /app/apps/captain
COPY --from=build /app/packages /app/packages
CMD ["eve", "start", "--host", "0.0.0.0", "--port", "8080"]
