import { afterEach, describe, expect, it, vi } from "vitest";

import { loadEnv } from "../services/app/env.js";

describe("Captain public environment", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("requires database and Telegram credentials in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_URL", "postgresql://captain.invalid/db");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "telegram-token");
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET_TOKEN", "telegram-webhook-secret");
    vi.stubEnv("SUPABASE_URL", "https://captain.supabase.co");
    vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_captain");
    vi.stubEnv("CAPTAIN_ADMIN_EMAILS", "Admin@Example.com, ops@example.com");
    vi.stubEnv("CAPTAIN_BETA_USER_LIMIT", undefined);
    vi.stubEnv("CAPTAIN_PUBLIC_BETA_ENABLED", undefined);
    vi.stubEnv("CAPTAIN_SIMPLIFIED_MULTI_CITY_ENABLED", undefined);
    vi.stubEnv("CAPTAIN_ARCHIVED_MODE", undefined);
    expect(loadEnv()).toMatchObject({
      mode: "production",
      betaUserLimit: 25,
      publicBetaEnabled: false,
      simplifiedMultiCityEnabled: false,
      adminEmails: ["admin@example.com", "ops@example.com"]
    });
  });

  it("forces public and scheduled work off in archived mode", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("CAPTAIN_ARCHIVED_MODE", "true");
    vi.stubEnv("CAPTAIN_PUBLIC_BETA_ENABLED", "true");
    vi.stubEnv("CAPTAIN_CONVERSATION_REVIEW_ENABLED", "true");

    expect(loadEnv()).toMatchObject({
      archivedMode: true,
      publicBetaEnabled: false,
      conversationReviewEnabled: false
    });
  });

  it("requires the complete private-admin identity configuration in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_URL", "postgresql://captain.invalid/db");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "telegram-token");
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET_TOKEN", "telegram-webhook-secret");
    vi.stubEnv("SUPABASE_URL", "https://captain.supabase.co");
    vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_captain");
    vi.stubEnv("CAPTAIN_ADMIN_EMAILS", "");

    expect(() => loadEnv()).toThrow("CAPTAIN_ADMIN_EMAILS");
  });

  it("uses Claude Sonnet by default while preserving an override", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AI_MODEL", "");
    expect(loadEnv().aiModel).toBe("anthropic/claude-sonnet-5");
    vi.stubEnv("AI_MODEL", "openai/custom-model");
    expect(loadEnv().aiModel).toBe("openai/custom-model");
  });

  it("uses the low-latency GPT-5.6 tier for structured Trip interpretation", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("TRIP_INTERPRETER_MODEL", "");
    expect(loadEnv().tripInterpreterModel).toBe("openai/gpt-5.6-luna");
    vi.stubEnv("TRIP_INTERPRETER_MODEL", "openai/custom-extractor");
    expect(loadEnv().tripInterpreterModel).toBe("openai/custom-extractor");
  });

  it("uses the transcription model configured for voice notes", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("TRANSCRIPTION_MODEL", "");
    expect(loadEnv().transcriptionModel).toBe("openai/gpt-4o-mini-transcribe");
    vi.stubEnv("TRANSCRIPTION_MODEL", "openai/custom-transcriber");
    expect(loadEnv().transcriptionModel).toBe("openai/custom-transcriber");
  });

  it("falls back to the in-memory store when no database is configured", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", "");
    expect(loadEnv()).toMatchObject({ databaseUrl: null });
  });

  it("defaults the private conversation review to Lagos and the requested recipients", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("CAPTAIN_CONVERSATION_REVIEW_ENABLED", undefined);
    vi.stubEnv("CAPTAIN_CONVERSATION_REVIEW_TIME_ZONE", undefined);
    vi.stubEnv("CAPTAIN_CONVERSATION_REVIEW_RECIPIENTS", undefined);
    expect(loadEnv()).toMatchObject({
      conversationReviewEnabled: false,
      conversationReviewTimeZone: "Africa/Lagos",
      conversationReviewModel: "openai/gpt-5.6-luna",
      conversationReviewRecipients: [
        "ope@moonlight.ng",
        "fawaz@moonlight.ng"
      ]
    });
  });

  it("configures the feedback bridge as an all-or-nothing pair", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("FEEDBACK_BRIDGE_URL", "https://pilot.example");
    vi.stubEnv("FEEDBACK_BRIDGE_SECRET", "feedback-secret");
    expect(loadEnv()).toMatchObject({
      feedbackBridgeUrl: "https://pilot.example",
      feedbackBridgeSecret: "feedback-secret"
    });

    vi.stubEnv("FEEDBACK_BRIDGE_SECRET", "");
    expect(() => loadEnv()).toThrow("must be configured together");
  });
});
