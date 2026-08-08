import { afterEach, describe, expect, it, vi } from "vitest";

import { loadEnv } from "../services/app/env.js";

describe("Captain public environment", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("requires database and Telegram credentials in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_URL", "postgresql://captain.invalid/db");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "telegram-token");
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET_TOKEN", "telegram-webhook-secret");
    vi.stubEnv("CAPTAIN_BETA_USER_LIMIT", undefined);
    vi.stubEnv("CAPTAIN_PUBLIC_BETA_ENABLED", undefined);
    vi.stubEnv("CAPTAIN_SIMPLIFIED_MULTI_CITY_ENABLED", undefined);
    expect(loadEnv()).toMatchObject({
      mode: "production",
      betaUserLimit: 25,
      publicBetaEnabled: false,
      simplifiedMultiCityEnabled: false
    });
  });

  it("uses the balanced GPT-5.6 tier by default while preserving an override", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AI_MODEL", "");
    expect(loadEnv().aiModel).toBe("openai/gpt-5.6-terra");
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

  it("falls back to the in-memory store when no database is configured", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", "");
    expect(loadEnv()).toMatchObject({ databaseUrl: null });
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
