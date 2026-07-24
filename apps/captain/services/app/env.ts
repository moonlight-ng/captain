export type CaptainEnv = {
  mode: "development" | "production";
  publicUrl: string;
  databaseUrl: string | null;
  basicUsername: string;
  basicPassword: string | null;
  ownerAuthEnabled: boolean;
  pilotBaseUrl: string | null;
  pilotToCaptainSecret: string | null;
  captainToPilotSecret: string | null;
  duffelAccessToken: string | null;
  duffelBaseUrl: string;
  duffelTimeoutMs: number;
  duffelSupplierTimeoutMs: number;
  telegramBotToken: string | null;
  telegramWebhookSecretToken: string | null;
  captainSessionSecret: string | null;
  duffelLiveMode: boolean;
  aiModel: string;
  aiGatewayApiKey: string | null;
};

export function loadEnv(): CaptainEnv {
  const mode = process.env.NODE_ENV === "production" ? "production" : "development";
  const env: CaptainEnv = {
    mode,
    publicUrl: (process.env.CAPTAIN_PUBLIC_URL?.trim() || "http://127.0.0.1:4178").replace(/\/$/, ""),
    databaseUrl: optional("DATABASE_URL"),
    basicUsername: process.env.CAPTAIN_BASIC_USERNAME?.trim() || "captain",
    basicPassword: optional("CAPTAIN_BASIC_PASSWORD"),
    ownerAuthEnabled: booleanValue("CAPTAIN_OWNER_AUTH_ENABLED", mode === "production"),
    pilotBaseUrl: optional("PILOT_BASE_URL"),
    pilotToCaptainSecret: optional("PILOT_TO_CAPTAIN_SECRET"),
    captainToPilotSecret: optional("CAPTAIN_TO_PILOT_SECRET"),
    duffelAccessToken: optional("DUFFEL_ACCESS_TOKEN"),
    duffelBaseUrl: (process.env.DUFFEL_BASE_URL?.trim() || "https://api.duffel.com").replace(/\/$/, ""),
    duffelTimeoutMs: positiveInteger("FLIGHT_SEARCH_TIMEOUT_MS", 120_000),
    duffelSupplierTimeoutMs: positiveInteger("DUFFEL_SUPPLIER_TIMEOUT_MS", 20_000),
    telegramBotToken: optional("TELEGRAM_BOT_TOKEN"),
    telegramWebhookSecretToken: optional("TELEGRAM_WEBHOOK_SECRET_TOKEN"),
    captainSessionSecret: optional("CAPTAIN_SESSION_SECRET"),
    duffelLiveMode: booleanValue("DUFFEL_LIVE_MODE", false),
    aiModel: process.env.AI_MODEL?.trim() || "openai/gpt-5.6-terra",
    aiGatewayApiKey: optional("AI_GATEWAY_API_KEY")
  };
  if (mode === "production") {
    for (const [name, value] of [
      ["DATABASE_URL", env.databaseUrl],
      ["PILOT_BASE_URL", env.pilotBaseUrl],
      ["PILOT_TO_CAPTAIN_SECRET", env.pilotToCaptainSecret],
      ["CAPTAIN_TO_PILOT_SECRET", env.captainToPilotSecret],
      ["DUFFEL_ACCESS_TOKEN", env.duffelAccessToken],
      ["TELEGRAM_BOT_TOKEN", env.telegramBotToken],
      ["TELEGRAM_WEBHOOK_SECRET_TOKEN", env.telegramWebhookSecretToken],
      ["CAPTAIN_SESSION_SECRET", env.captainSessionSecret]
    ] as const) {
      if (!value) throw new Error(`Missing required production environment variable: ${name}`);
    }
    if (env.ownerAuthEnabled && !env.basicPassword) {
      throw new Error("Missing required production environment variable: CAPTAIN_BASIC_PASSWORD");
    }
  }
  return env;
}

function optional(name: string): string | null {
  return process.env[name]?.trim() || null;
}

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function booleanValue(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}
