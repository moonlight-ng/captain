import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("Watch retention clock migration", () => {
  it("uses the scheduled search run clock for every retention cutoff", () => {
    const migration = readFileSync(join(
      process.cwd(),
      "database/migrations/006_use_search_clock_for_watch_retention.sql"
    ), "utf8");

    expect(migration).toContain("create or replace function captain.maintain_watch_retention()");
    expect(migration).toContain("observed_at < new.created_at - interval '90 days'");
    expect(migration).toContain("observed_at < new.created_at - interval '7 days'");
    expect(migration).toContain("expires_at <= new.created_at");
    expect(migration).toContain("completed_at < new.created_at - interval '7 days'");
    expect(migration).not.toContain("now()");
  });
});
