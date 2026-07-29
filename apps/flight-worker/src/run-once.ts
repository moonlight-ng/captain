import postgres from "postgres";
import { PostgresCaptainPlatformStore } from "@agents/flight-store";
import { logEvent } from "@agents/observability";
import { DuffelFlightSearchProvider } from "@agents/provider-duffel";

import { loadWorkerEnv } from "./env.js";
import { FlightWorker } from "./worker.js";

const env = loadWorkerEnv({
  ...process.env,
  CAPTAIN_PUBLIC_URL: process.env.CAPTAIN_PUBLIC_URL?.trim() || "https://dr-captain.fly.dev",
  TRACKING_KILL_SWITCH: "false",
  FLIGHT_WORKER_CLAIM_LIMIT: process.env.FLIGHT_WORKER_CLAIM_LIMIT ?? "4",
  FLIGHT_WORKER_LEASE_MS: process.env.FLIGHT_WORKER_LEASE_MS ?? "600000"
});

const sql = postgres(env.databaseUrl, { max: 1, ssl: "require" });
const forced = await sql`
  update captain.watches
  set next_check_at = ${new Date()}, delayed_at = null, delay_reason = null, updated_at = ${new Date()}
  where status = 'active'
  returning id, trip_id, next_check_at
`;
console.log(JSON.stringify({ forcedDue: forced, provider: "official_duffel" }, null, 2));
await sql.end({ timeout: 5 });

const provider = new DuffelFlightSearchProvider({
  accessToken: env.duffelAccessToken,
  baseUrl: env.duffelBaseUrl
});

const store = PostgresCaptainPlatformStore.connect(env.databaseUrl, 6);
const worker = new FlightWorker({
  store,
  provider,
  telegramBotToken: env.telegramBotToken,
  captainPublicUrl: env.captainPublicUrl,
  trackingEnabled: true,
  dailyResponseLimit: env.dailyResponseLimit,
  workerId: `${env.workerId}-manual`,
  leaseMs: env.leaseMs,
  freshnessMs: 0,
  claimLimit: env.claimLimit
});

try {
  const startedAt = Date.now();
  const result = await worker.tick(new Date());
  logEvent("info", "flight_worker.manual_tick_done", {
    ...result,
    provider: provider.provider,
    duration_ms: Date.now() - startedAt
  });
  console.log(JSON.stringify({
    tick: result,
    provider: provider.provider,
    durationMs: Date.now() - startedAt
  }, null, 2));
} finally {
  await store.close();
}
