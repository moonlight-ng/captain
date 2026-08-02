import { createServer } from "node:http";

import { PostgresCaptainPlatformStore } from "@agents/flight-store";
import { logEvent } from "@agents/observability";
import { DuffelCardsClient, DuffelFlightSearchProvider } from "@agents/provider-duffel";
import {
  FallbackFlightSearchProvider,
  FlysoarMcpFlightSearchProvider
} from "@agents/provider-flysoar";

import { idleTickDelayMs, loadWorkerEnv } from "./env.js";
import { FlightWorker } from "./worker.js";

const env = loadWorkerEnv();
const store = PostgresCaptainPlatformStore.connect(env.databaseUrl, 1);
const primaryProvider = new DuffelFlightSearchProvider({
  accessToken: env.duffelAccessToken,
  baseUrl: env.duffelBaseUrl
});
const cardsClient = new DuffelCardsClient({
  accessToken: env.duffelAccessToken,
  baseUrl: env.duffelBaseUrl,
  cardsBaseUrl: env.duffelCardsBaseUrl
});
const fallbackProvider = new FlysoarMcpFlightSearchProvider({
  mcpUrl: env.flysoarMcpUrl
});
const provider = new FallbackFlightSearchProvider({
  primary: primaryProvider,
  fallback: fallbackProvider
});

const worker = new FlightWorker({
  store,
  provider,
  cardsClient,
  telegramBotToken: env.telegramBotToken,
  captainPublicUrl: env.captainPublicUrl,
  trackingEnabled: env.trackingEnabled,
  workerId: env.workerId,
  leaseMs: env.leaseMs,
  freshnessMs: env.freshnessMs,
  claimLimit: env.claimLimit
});

let ready = false;
let timer: NodeJS.Timeout | undefined;
let consecutiveIdleTicks = 0;

async function tick(): Promise<void> {
  let nextTickMs = env.tickMs;
  try {
    await worker.tick();
    ready = true;
    consecutiveIdleTicks = worker.lastTickHadDueWork ? 0 : consecutiveIdleTicks + 1;
    nextTickMs = idleTickDelayMs(env.tickMs, env.maxIdleTickMs, consecutiveIdleTicks);
  } catch (error) {
    ready = false;
    consecutiveIdleTicks = 0;
    logEvent("error", "flight_worker.tick_failed", { error: error instanceof Error ? error.message : "Unknown error" });
  } finally {
    timer = setTimeout(() => void tick(), nextTickMs);
    timer.unref();
  }
}

const server = createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" }).end('{"status":"ok"}');
    return;
  }
  if (request.url === "/ready") {
    response.writeHead(ready ? 200 : 503, { "content-type": "application/json" })
      .end(JSON.stringify({
        status: ready ? "ready" : "starting",
        provider: provider.provider,
        fallbackProvider: fallbackProvider.provider
      }));
    return;
  }
  response.writeHead(404).end();
});

server.listen(env.port, "0.0.0.0", () => {
  logEvent("info", "flight_worker.started", {
    worker_id: env.workerId,
    port: env.port,
    provider: provider.provider,
    fallback_provider: fallbackProvider.provider
  });
  void tick();
});

async function shutdown(): Promise<void> {
  if (timer) clearTimeout(timer);
  server.close();
  await store.close();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
