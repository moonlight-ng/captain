export type WorkerEnv = {
  databaseUrl: string;
  duffelAccessToken: string;
  duffelBaseUrl: string;
  telegramBotToken: string;
  captainPublicUrl: string;
  trackingEnabled: boolean;
  dailyResponseLimit: number;
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
    duffelBaseUrl: (source.DUFFEL_BASE_URL?.trim() || "https://api.duffel.com").replace(/\/$/u, ""),
    telegramBotToken: required(source, "TELEGRAM_BOT_TOKEN"),
    captainPublicUrl: required(source, "CAPTAIN_PUBLIC_URL").replace(/\/$/u, ""),
    trackingEnabled: !booleanValue(source.TRACKING_KILL_SWITCH, false),
    dailyResponseLimit: positive(source, "DAILY_RESPONSES_CEILING", 500),
    workerId: source.FLIGHT_WORKER_ID?.trim() || `worker-${process.pid}`,
    port: positive(source, "PORT", 8080),
    tickMs: positive(source, "FLIGHT_WORKER_TICK_MS", 60_000),
    leaseMs: positive(source, "FLIGHT_WORKER_LEASE_MS", 240_000),
    freshnessMs: positive(source, "FLIGHT_SEARCH_FRESHNESS_MS", 900_000),
    claimLimit: positive(source, "FLIGHT_WORKER_CLAIM_LIMIT", 1)
  };
}

function booleanValue(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return !["0", "false", "off", "no"].includes(value.trim().toLowerCase());
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
