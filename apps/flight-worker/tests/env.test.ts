import { describe, expect, it } from "vitest";

import { idleTickDelayMs, loadWorkerEnv } from "../src/env.js";

const REQUIRED_ENV = {
  DATABASE_URL: "postgresql://captain",
  DUFFEL_ACCESS_TOKEN: "duffel",
  TELEGRAM_BOT_TOKEN: "telegram",
  CAPTAIN_PUBLIC_URL: "https://captain.example.com"
};

describe("flight worker idle schedule", () => {
  it("backs off empty polls without exceeding five minutes", () => {
    expect(idleTickDelayMs(60_000, 300_000, 0)).toBe(60_000);
    expect(idleTickDelayMs(60_000, 300_000, 1)).toBe(120_000);
    expect(idleTickDelayMs(60_000, 300_000, 2)).toBe(240_000);
    expect(idleTickDelayMs(60_000, 300_000, 3)).toBe(300_000);
    expect(idleTickDelayMs(60_000, 300_000, 20)).toBe(300_000);
  });

  it("never configures the idle interval below the active interval", () => {
    const env = loadWorkerEnv({
      ...REQUIRED_ENV,
      FLIGHT_WORKER_TICK_MS: "120000",
      FLIGHT_WORKER_MAX_IDLE_TICK_MS: "60000"
    });
    expect(env.tickMs).toBe(120_000);
    expect(env.maxIdleTickMs).toBe(120_000);
    expect(env.flysoarMcpUrl).toBe("https://mcp.flysoar.ai/mcp");
  });
});
