import { afterEach, describe, expect, it, vi } from "vitest";

import { loadEnv } from "../services/app/env.js";

describe("owner authentication environment", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("requires an owner password by default in production", () => {
    stubProductionEnv();
    vi.stubEnv("FLIGHT_AGENT_BASIC_PASSWORD", "");

    expect(() => loadEnv()).toThrow("FLIGHT_AGENT_BASIC_PASSWORD");
  });

  it("allows the owner UI and API to be public when explicitly disabled", () => {
    stubProductionEnv();
    vi.stubEnv("FLIGHT_AGENT_BASIC_PASSWORD", "");
    vi.stubEnv("FLIGHT_AGENT_OWNER_AUTH_ENABLED", "false");

    expect(loadEnv().ownerAuthEnabled).toBe(false);
  });
});

function stubProductionEnv(): void {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("DATABASE_URL", "postgresql://flight-agent.invalid/db");
  vi.stubEnv("CAPTAIN_BASE_URL", "https://captain.invalid");
  vi.stubEnv("CAPTAIN_TO_FLIGHT_AGENT_SECRET", "captain-to-flight-agent");
  vi.stubEnv("FLIGHT_AGENT_TO_CAPTAIN_SECRET", "flight-agent-to-captain");
  vi.stubEnv("DUFFEL_ACCESS_TOKEN", "duffel-token");
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "telegram-token");
  vi.stubEnv("TELEGRAM_WEBHOOK_SECRET_TOKEN", "telegram-webhook-secret");
  vi.stubEnv("CAPTAIN_SESSION_SECRET", "captain-session-secret");
  vi.stubEnv("FLIGHT_AGENT_OWNER_AUTH_ENABLED", "");
}
