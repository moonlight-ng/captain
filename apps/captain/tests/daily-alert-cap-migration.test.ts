import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PROFILE } from "@agents/flight-domain";

describe("Daily alert cap migration", () => {
  const migration = readFileSync(
    resolve(process.cwd(), "database/migrations/014_daily_alert_cap_defaults_to_one.sql"),
    "utf8"
  );

  it("moves the column default to the cap the domain already applies", () => {
    expect(DEFAULT_PROFILE.maxAlertsPerDay).toBe(1);
    expect(migration).toContain("alter column max_alerts_per_day set default 1");
  });

  it("leaves travellers who raised their own cap alone", () => {
    expect(migration).not.toMatch(/update\s+captain\.traveller_profiles/iu);
  });
});
