import { afterEach, describe, expect, it, vi } from "vitest";

import { loadEnv } from "../services/app/env.js";

describe("owner authentication environment", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("requires an owner password by default in production", () => {
    stubProductionEnv();
    vi.stubEnv("CAPTAIN_BASIC_PASSWORD", "");

    expect(() => loadEnv()).toThrow("CAPTAIN_BASIC_PASSWORD");
  });

  it("allows the owner UI and API to be public when explicitly disabled", () => {
    stubProductionEnv();
    vi.stubEnv("CAPTAIN_BASIC_PASSWORD", "");
    vi.stubEnv("CAPTAIN_OWNER_AUTH_ENABLED", "false");

    expect(loadEnv().ownerAuthEnabled).toBe(false);
  });

  it("uses the balanced GPT-5.6 tier by default while preserving the override", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AI_MODEL", "");
    expect(loadEnv().aiModel).toBe("openai/gpt-5.6-terra");
    vi.stubEnv("AI_MODEL", "openai/custom-model");
    expect(loadEnv().aiModel).toBe("openai/custom-model");
  });
});

function stubProductionEnv(): void {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("DATABASE_URL", "postgresql://flight-agent.invalid/db");
  vi.stubEnv("PILOT_BASE_URL", "https://pilot.invalid");
  vi.stubEnv("PILOT_TO_CAPTAIN_SECRET", "pilot-to-captain");
  vi.stubEnv("CAPTAIN_TO_PILOT_SECRET", "captain-to-pilot");
  vi.stubEnv("DUFFEL_ACCESS_TOKEN", "duffel-token");
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "telegram-token");
  vi.stubEnv("TELEGRAM_WEBHOOK_SECRET_TOKEN", "telegram-webhook-secret");
  vi.stubEnv("CAPTAIN_SESSION_SECRET", "captain-session-secret");
  vi.stubEnv("CAPTAIN_OWNER_AUTH_ENABLED", "");
}
