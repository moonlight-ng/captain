FROM node:24-bookworm-slim AS build

WORKDIR /app
ENV CI=true
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
RUN pnpm install --frozen-lockfile

COPY tsconfig*.json vite.config.ts index.html ./
COPY src ./src
COPY agent ./agent
COPY services ./services
COPY scripts ./scripts
COPY migrations ./migrations
RUN pnpm build
RUN pnpm prune --prod

FROM node:24-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV PATH="/app/node_modules/.bin:${PATH}"
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/tsconfig*.json ./
COPY --from=build /app/agent ./agent
COPY --from=build /app/services ./services
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/dist ./dist
COPY --from=build /app/.eve ./.eve
COPY --from=build /app/.output ./.output

CMD ["eve", "start", "--host", "0.0.0.0", "--port", "8080"]
