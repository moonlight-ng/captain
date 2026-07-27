import { afterEach, describe, expect, it, vi } from "vitest";

import { loadEnv } from "../services/app/env.js";

describe("Captain public environment", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("requires only database and Telegram credentials in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_URL", "postgresql://captain.invalid/db");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "telegram-token");
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET_TOKEN", "telegram-webhook-secret");
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
});
