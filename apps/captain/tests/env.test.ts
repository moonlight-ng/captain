import { afterEach, describe, expect, it, vi } from "vitest";

import { loadEnv } from "../services/app/env.js";

describe("Captain public environment", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("requires only database and Telegram credentials in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_URL", "postgresql://captain.invalid/db");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "telegram-token");
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET_TOKEN", "telegram-webhook-secret");
    vi.stubEnv("CAPTAIN_BETA_USER_LIMIT", undefined);
    vi.stubEnv("CAPTAIN_PUBLIC_BETA_ENABLED", undefined);
    expect(loadEnv()).toMatchObject({
      mode: "production",
      betaUserLimit: 25,
      publicBetaEnabled: false
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

  it("requires DATABASE_URL and DUFFEL_ACCESS_TOKEN when payments are enabled", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("CAPTAIN_PAYMENTS_ENABLED", "true");
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("DUFFEL_ACCESS_TOKEN", "duffel_test_token");
    expect(() => loadEnv()).toThrow(/DATABASE_URL is required when CAPTAIN_PAYMENTS_ENABLED is true/u);

    vi.stubEnv("DATABASE_URL", "postgresql://captain.invalid/db");
    vi.stubEnv("DUFFEL_ACCESS_TOKEN", "");
    expect(() => loadEnv()).toThrow(/DUFFEL_ACCESS_TOKEN is required when CAPTAIN_PAYMENTS_ENABLED is true/u);

    vi.stubEnv("DUFFEL_ACCESS_TOKEN", "duffel_test_token");
    expect(loadEnv()).toMatchObject({
      paymentsEnabled: true,
      databaseUrl: "postgresql://captain.invalid/db",
      duffelAccessToken: "duffel_test_token"
    });
  });
});
