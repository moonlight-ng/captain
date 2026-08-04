export type CaptainEnv = {
  mode: "development" | "production";
  publicUrl: string;
  databaseUrl: string | null;
  telegramBotToken: string | null;
  telegramWebhookSecretToken: string | null;
  piiEncryptionKey: string | null;
  aiModel: string;
  tripInterpreterModel: string;
  aiGatewayApiKey: string | null;
  betaUserLimit: number;
  publicBetaEnabled: boolean;
  paymentsEnabled: boolean;
  duffelAccessToken: string | null;
  duffelBaseUrl: string;
  duffelCardsBaseUrl: string;
};

export function loadEnv(): CaptainEnv {
  const mode = process.env.NODE_ENV === "production" ? "production" : "development";
  const env: CaptainEnv = {
    mode,
    publicUrl: (process.env.CAPTAIN_PUBLIC_URL?.trim() || "http://127.0.0.1:4178").replace(/\/$/, ""),
    databaseUrl: optional("DATABASE_URL"),
    telegramBotToken: optional("TELEGRAM_BOT_TOKEN"),
    telegramWebhookSecretToken: optional("TELEGRAM_WEBHOOK_SECRET_TOKEN"),
    piiEncryptionKey: optional("CAPTAIN_PII_ENCRYPTION_KEY"),
    aiModel: process.env.AI_MODEL?.trim() || "openai/gpt-5.6-terra",
    tripInterpreterModel: process.env.TRIP_INTERPRETER_MODEL?.trim() || "openai/gpt-5.6-luna",
    aiGatewayApiKey: optional("AI_GATEWAY_API_KEY"),
    betaUserLimit: positiveInteger("CAPTAIN_BETA_USER_LIMIT", 25),
    publicBetaEnabled: booleanValue(
      process.env.CAPTAIN_PUBLIC_BETA_ENABLED,
      mode !== "production"
    ),
    paymentsEnabled: booleanValue(process.env.CAPTAIN_PAYMENTS_ENABLED, false),
    duffelAccessToken: optional("DUFFEL_ACCESS_TOKEN"),
    duffelBaseUrl: (process.env.DUFFEL_BASE_URL?.trim() || "https://api.duffel.com").replace(/\/$/u, ""),
    duffelCardsBaseUrl: (
      process.env.DUFFEL_CARDS_BASE_URL?.trim() || "https://api.duffel.cards"
    ).replace(/\/$/u, "")
  };
  if (mode === "production") {
    for (const [name, value] of [
      ["DATABASE_URL", env.databaseUrl],
      ["TELEGRAM_BOT_TOKEN", env.telegramBotToken],
      ["TELEGRAM_WEBHOOK_SECRET_TOKEN", env.telegramWebhookSecretToken],
      ["CAPTAIN_PII_ENCRYPTION_KEY", env.piiEncryptionKey]
    ] as const) {
      if (!value) throw new Error(`Missing required production environment variable: ${name}`);
    }
  }
  if (env.paymentsEnabled) {
    if (!env.databaseUrl) {
      throw new Error("DATABASE_URL is required when CAPTAIN_PAYMENTS_ENABLED is true");
    }
    if (!env.duffelAccessToken) {
      throw new Error("DUFFEL_ACCESS_TOKEN is required when CAPTAIN_PAYMENTS_ENABLED is true");
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

function booleanValue(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return !["0", "false", "off", "no"].includes(value.trim().toLowerCase());
}
