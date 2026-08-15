export type WorkerEnv = {
  databaseUrl: string;
  duffelAccessToken: string;
  duffelBaseUrl: string;
  flysoarMcpUrl: string;
  telegramBotToken: string;
  captainPublicUrl: string;
  aiGatewayApiKey: string | null;
  languageModel: string;
  trackingEnabled: boolean;
  workerId: string;
  port: number;
  tickMs: number;
  maxIdleTickMs: number;
  leaseMs: number;
  freshnessMs: number;
  claimLimit: number;
};

export function loadWorkerEnv(source: NodeJS.ProcessEnv = process.env): WorkerEnv {
  const tickMs = positive(source, "FLIGHT_WORKER_TICK_MS", 60_000);
  return {
    databaseUrl: required(source, "DATABASE_URL"),
    duffelAccessToken: required(source, "DUFFEL_ACCESS_TOKEN"),
    duffelBaseUrl: (source.DUFFEL_BASE_URL?.trim() || "https://api.duffel.com").replace(/\/$/u, ""),
    flysoarMcpUrl: (source.FLYSOAR_MCP_URL?.trim() || "https://mcp.flysoar.ai/mcp").replace(/\/$/u, ""),
    telegramBotToken: required(source, "TELEGRAM_BOT_TOKEN"),
    captainPublicUrl: required(source, "CAPTAIN_PUBLIC_URL").replace(/\/$/u, ""),
    aiGatewayApiKey: source.AI_GATEWAY_API_KEY?.trim() || null,
    languageModel: source.CAPTAIN_LANGUAGE_MODEL?.trim() || "openai/gpt-5.6-luna",
    trackingEnabled: !booleanValue(source.TRACKING_KILL_SWITCH, false),
    workerId: source.FLIGHT_WORKER_ID?.trim() || `worker-${process.pid}`,
    port: positive(source, "PORT", 8080),
    tickMs,
    maxIdleTickMs: Math.max(
      tickMs,
      positive(source, "FLIGHT_WORKER_MAX_IDLE_TICK_MS", 300_000)
    ),
    leaseMs: positive(source, "FLIGHT_WORKER_LEASE_MS", 240_000),
    freshnessMs: positive(source, "FLIGHT_SEARCH_FRESHNESS_MS", 900_000),
    claimLimit: positive(source, "FLIGHT_WORKER_CLAIM_LIMIT", 1)
  };
}

export function idleTickDelayMs(
  tickMs: number,
  maxIdleTickMs: number,
  consecutiveIdleTicks: number
): number {
  if (consecutiveIdleTicks <= 0) return tickMs;
  const multiplier = 2 ** Math.min(consecutiveIdleTicks, 10);
  return Math.min(maxIdleTickMs, tickMs * multiplier);
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
