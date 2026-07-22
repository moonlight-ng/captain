export type WorkerEnv = {
  databaseUrl: string;
  duffelAccessToken: string;
  duffelBaseUrl: string;
  telegramBotToken: string;
  workerId: string;
  port: number;
  tickMs: number;
  leaseMs: number;
  freshnessMs: number;
  claimLimit: number;
};

export function loadWorkerEnv(source: NodeJS.ProcessEnv = process.env): WorkerEnv {
  return {
    databaseUrl: required(source, "DATABASE_URL"),
    duffelAccessToken: required(source, "DUFFEL_ACCESS_TOKEN"),
    duffelBaseUrl: (source.DUFFEL_BASE_URL?.trim() || "https://api.duffel.com").replace(/\/$/, ""),
    telegramBotToken: required(source, "TELEGRAM_BOT_TOKEN"),
    workerId: source.FLIGHT_WORKER_ID?.trim() || `worker-${process.pid}`,
    port: positive(source, "PORT", 8080),
    tickMs: positive(source, "FLIGHT_WORKER_TICK_MS", 60_000),
    leaseMs: positive(source, "FLIGHT_WORKER_LEASE_MS", 180_000),
    freshnessMs: positive(source, "FLIGHT_SEARCH_FRESHNESS_MS", 900_000),
    claimLimit: positive(source, "FLIGHT_WORKER_CLAIM_LIMIT", 4)
  };
}

function required(source: NodeJS.ProcessEnv, name: string): string {
  const value = source[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positive(source: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = Number(source[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
