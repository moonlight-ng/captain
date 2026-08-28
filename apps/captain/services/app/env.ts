import { isCaptainArchivedMode } from "./archive.js";

export type CaptainEnv = {
  mode: "development" | "production";
  archivedMode: boolean;
  publicUrl: string;
  databaseUrl: string | null;
  telegramBotToken: string | null;
  telegramWebhookSecretToken: string | null;
  feedbackBridgeUrl: string | null;
  feedbackBridgeSecret: string | null;
  aiModel: string;
  tripInterpreterModel: string;
  transcriptionModel: string;
  languageModel: string;
  aiGatewayApiKey: string | null;
  supabaseUrl: string | null;
  supabasePublishableKey: string | null;
  adminEmails: string[];
  conversationReviewEnabled: boolean;
  conversationReviewTimeZone: string;
  conversationReviewModel: string;
  conversationReviewRecipients: string[];
  conversationReviewFrom: string | null;
  resendApiKey: string | null;
  betaUserLimit: number;
  publicBetaEnabled: boolean;
  simplifiedMultiCityEnabled: boolean;
  duffelAccessToken: string | null;
  duffelBaseUrl: string;
};

export function loadEnv(): CaptainEnv {
  const mode = process.env.NODE_ENV === "production" ? "production" : "development";
  const archivedMode = isCaptainArchivedMode();
  const feedbackBridgeUrl = optional("FEEDBACK_BRIDGE_URL");
  const feedbackBridgeSecret = optional("FEEDBACK_BRIDGE_SECRET");
  if (Boolean(feedbackBridgeUrl) !== Boolean(feedbackBridgeSecret)) {
    throw new Error("FEEDBACK_BRIDGE_URL and FEEDBACK_BRIDGE_SECRET must be configured together");
  }
  if (feedbackBridgeUrl) {
    const protocol = new URL(feedbackBridgeUrl).protocol;
    if (mode === "production" && protocol !== "https:") {
      throw new Error("FEEDBACK_BRIDGE_URL must use HTTPS in production");
    }
    if (protocol !== "https:" && protocol !== "http:") {
      throw new Error("FEEDBACK_BRIDGE_URL must use HTTP or HTTPS");
    }
  }
  const env: CaptainEnv = {
    mode,
    archivedMode,
    publicUrl: (process.env.CAPTAIN_PUBLIC_URL?.trim() || "http://127.0.0.1:4178").replace(/\/$/, ""),
    databaseUrl: optional("DATABASE_URL"),
    telegramBotToken: optional("TELEGRAM_BOT_TOKEN"),
    telegramWebhookSecretToken: optional("TELEGRAM_WEBHOOK_SECRET_TOKEN"),
    feedbackBridgeUrl,
    feedbackBridgeSecret,
    aiModel: process.env.AI_MODEL?.trim() || "anthropic/claude-sonnet-5",
    tripInterpreterModel: process.env.TRIP_INTERPRETER_MODEL?.trim() || "openai/gpt-5.6-luna",
    transcriptionModel: process.env.TRANSCRIPTION_MODEL?.trim() || "openai/gpt-4o-mini-transcribe",
    languageModel: process.env.CAPTAIN_LANGUAGE_MODEL?.trim()
      || process.env.TRIP_INTERPRETER_MODEL?.trim()
      || "openai/gpt-5.6-luna",
    aiGatewayApiKey: optional("AI_GATEWAY_API_KEY"),
    supabaseUrl: optional("SUPABASE_URL"),
    supabasePublishableKey: optional("SUPABASE_PUBLISHABLE_KEY"),
    adminEmails: emailList(process.env.CAPTAIN_ADMIN_EMAILS),
    conversationReviewEnabled: !archivedMode && booleanValue(
      process.env.CAPTAIN_CONVERSATION_REVIEW_ENABLED,
      false
    ),
    conversationReviewTimeZone:
      process.env.CAPTAIN_CONVERSATION_REVIEW_TIME_ZONE?.trim()
      || "Africa/Lagos",
    conversationReviewModel:
      process.env.CAPTAIN_CONVERSATION_REVIEW_MODEL?.trim()
      || process.env.TRIP_INTERPRETER_MODEL?.trim()
      || "openai/gpt-5.6-luna",
    conversationReviewRecipients: emailList(
      process.env.CAPTAIN_CONVERSATION_REVIEW_RECIPIENTS
      || "ope@moonlight.ng,fawaz@moonlight.ng"
    ),
    conversationReviewFrom: optional("CAPTAIN_CONVERSATION_REVIEW_FROM"),
    resendApiKey: optional("RESEND_API_KEY"),
    betaUserLimit: positiveInteger("CAPTAIN_BETA_USER_LIMIT", 25),
    publicBetaEnabled: !archivedMode && booleanValue(
      process.env.CAPTAIN_PUBLIC_BETA_ENABLED,
      mode !== "production"
    ),
    simplifiedMultiCityEnabled: booleanValue(
      process.env.CAPTAIN_SIMPLIFIED_MULTI_CITY_ENABLED,
      mode !== "production"
    ),
    duffelAccessToken: optional("DUFFEL_ACCESS_TOKEN"),
    duffelBaseUrl: (process.env.DUFFEL_BASE_URL?.trim() || "https://api.duffel.com").replace(/\/$/u, "")
  };
  assertTimeZone(env.conversationReviewTimeZone);
  if (mode === "production") {
    for (const [name, value] of [
      ["DATABASE_URL", env.databaseUrl],
      ["TELEGRAM_BOT_TOKEN", env.telegramBotToken],
      ["TELEGRAM_WEBHOOK_SECRET_TOKEN", env.telegramWebhookSecretToken],
      ["SUPABASE_URL", env.supabaseUrl],
      ["SUPABASE_PUBLISHABLE_KEY", env.supabasePublishableKey],
      ["CAPTAIN_ADMIN_EMAILS", env.adminEmails.length > 0 ? "configured" : null]
    ] as const) {
      if (!value) throw new Error(`Missing required production environment variable: ${name}`);
    }
  }
  return env;
}

function assertTimeZone(value: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
  } catch {
    throw new Error(`Invalid CAPTAIN_CONVERSATION_REVIEW_TIME_ZONE: ${value}`);
  }
}

function emailList(value: string | undefined): string[] {
  return [...new Set((value ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)))];
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
