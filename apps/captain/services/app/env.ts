export type CaptainEnv = {
  mode: "development" | "production";
  publicUrl: string;
  databaseUrl: string | null;
  telegramBotToken: string | null;
  telegramWebhookSecretToken: string | null;
  aiModel: string;
  tripInterpreterModel: string;
  aiGatewayApiKey: string | null;
  betaUserLimit: number;
  publicBetaEnabled: boolean;
  duffelAccessToken: string | null;
  duffelBaseUrl: string;
};

export function loadEnv(): CaptainEnv {
  const mode = process.env.NODE_ENV === "production" ? "production" : "development";
  const env: CaptainEnv = {
    mode,
    publicUrl: (process.env.CAPTAIN_PUBLIC_URL?.trim() || "http://127.0.0.1:4178").replace(/\/$/, ""),
    databaseUrl: optional("DATABASE_URL"),
    telegramBotToken: optional("TELEGRAM_BOT_TOKEN"),
    telegramWebhookSecretToken: optional("TELEGRAM_WEBHOOK_SECRET_TOKEN"),
    aiModel: process.env.AI_MODEL?.trim() || "openai/gpt-5.6-terra",
    tripInterpreterModel: process.env.TRIP_INTERPRETER_MODEL?.trim() || "openai/gpt-5.6-luna",
    aiGatewayApiKey: optional("AI_GATEWAY_API_KEY"),
    betaUserLimit: positiveInteger("CAPTAIN_BETA_USER_LIMIT", 25),
    publicBetaEnabled: booleanValue(
      process.env.CAPTAIN_PUBLIC_BETA_ENABLED,
      mode !== "production"
    ),
    duffelAccessToken: optional("DUFFEL_ACCESS_TOKEN"),
    duffelBaseUrl: (process.env.DUFFEL_BASE_URL?.trim() || "https://api.duffel.com").replace(/\/$/u, "")
  };
  if (mode === "production") {
    for (const [name, value] of [
      ["DATABASE_URL", env.databaseUrl],
      ["TELEGRAM_BOT_TOKEN", env.telegramBotToken],
      ["TELEGRAM_WEBHOOK_SECRET_TOKEN", env.telegramWebhookSecretToken]
    ] as const) {
      if (!value) throw new Error(`Missing required production environment variable: ${name}`);
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
