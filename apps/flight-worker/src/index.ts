import { createServer } from "node:http";

import { PostgresCaptainPlatformStore } from "@agents/flight-store";
import { logEvent } from "@agents/observability";
import { DuffelFlightSearchProvider } from "@agents/provider-duffel";
import { OpenAIWebFlightSearchProvider, type FlightSearchProvider } from "@agents/provider-web";

import { loadWorkerEnv } from "./env.js";
import { FlightWorker } from "./worker.js";

const env = loadWorkerEnv();
const store = PostgresCaptainPlatformStore.connect(env.databaseUrl, 6);
const provider: FlightSearchProvider = env.inventoryProvider === "openai_web"
  ? new OpenAIWebFlightSearchProvider({
      apiKey: env.openaiApiKey,
      baseUrl: env.openaiBaseUrl,
      model: env.openaiModel,
      approvedDomains: env.approvedDomains
    })
  : new DuffelFlightSearchProvider({
      accessToken: env.duffelAccessToken,
      baseUrl: env.duffelBaseUrl
    });

const worker = new FlightWorker({
  store,
  provider,
  telegramBotToken: env.telegramBotToken,
  captainPublicUrl: env.captainPublicUrl,
  trackingEnabled: env.trackingEnabled,
  dailyResponseLimit: env.dailyResponseLimit,
  workerId: env.workerId,
  leaseMs: env.leaseMs,
  freshnessMs: env.freshnessMs,
  claimLimit: env.claimLimit
});

let ready = false;
let timer: NodeJS.Timeout | undefined;

async function tick(): Promise<void> {
  try {
    await worker.tick();
    ready = true;
  } catch (error) {
    ready = false;
    logEvent("error", "flight_worker.tick_failed", { error: error instanceof Error ? error.message : "Unknown error" });
  } finally {
    timer = setTimeout(() => void tick(), env.tickMs);
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
      .end(JSON.stringify({ status: ready ? "ready" : "starting", provider: env.inventoryProvider }));
    return;
  }
  response.writeHead(404).end();
});

server.listen(env.port, "0.0.0.0", () => {
  logEvent("info", "flight_worker.started", {
    worker_id: env.workerId,
    port: env.port,
    provider: env.inventoryProvider
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
