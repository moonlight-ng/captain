import { createServer } from "node:http";

import {
  FLIGHT_WORKER_WAKE_CHANNEL,
  PostgresCaptainPlatformStore
} from "@agents/flight-store";
import { logEvent } from "@agents/observability";
import { DuffelFlightSearchProvider } from "@agents/provider-duffel";
import {
  FallbackFlightSearchProvider,
  FlysoarMcpFlightSearchProvider
} from "@agents/provider-flysoar";
import postgres from "postgres";
import { TelegramLanguageService } from "@agents/telegram-core";

import { loadWorkerEnv } from "./env.js";
import { InterruptibleWorkerScheduler } from "./scheduler.js";
import { FlightWorker } from "./worker.js";

const env = loadWorkerEnv();
const store = PostgresCaptainPlatformStore.connect(env.databaseUrl, 1);
const primaryProvider = new DuffelFlightSearchProvider({
  accessToken: env.duffelAccessToken,
  baseUrl: env.duffelBaseUrl
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
  telegramBotToken: env.telegramBotToken,
  captainPublicUrl: env.captainPublicUrl,
  trackingEnabled: env.trackingEnabled,
  workerId: env.workerId,
  leaseMs: env.leaseMs,
  freshnessMs: env.freshnessMs,
  claimLimit: env.claimLimit,
  language: new TelegramLanguageService({
    apiKey: env.aiGatewayApiKey,
    model: env.languageModel
  })
});

let ready = false;
const scheduler = new InterruptibleWorkerScheduler({
  tickMs: env.tickMs,
  maxIdleTickMs: env.maxIdleTickMs,
  async run() {
    await worker.tick();
    ready = true;
    return worker.lastTickHadDueWork;
  },
  onError(error) {
    ready = false;
    logEvent("error", "flight_worker.tick_failed", { error: error instanceof Error ? error.message : "Unknown error" });
  }
});
const wakeSql = postgres(env.databaseUrl, {
  max: 1,
  connect_timeout: 15,
  transform: { undefined: null }
});

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
  scheduler.start();
  void wakeSql.listen(
    FLIGHT_WORKER_WAKE_CHANNEL,
    () => {
      logEvent("info", "flight_worker.wake_received", {});
      scheduler.wake();
    },
    () => logEvent("info", "flight_worker.wake_listener_ready", {})
  ).catch((error) => {
    logEvent("error", "flight_worker.wake_listener_failed", {
      error: error instanceof Error ? error.message : "Unknown error"
    });
  });
});

async function shutdown(): Promise<void> {
  scheduler.stop();
  server.close();
  await wakeSql.end({ timeout: 5 });
  await store.close();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
