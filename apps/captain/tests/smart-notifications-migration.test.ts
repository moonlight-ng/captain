import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("Smart notifications migration", () => {
  it("allows the scheduled watch status before backfilling it", () => {
    const migration = readFileSync(join(
      process.cwd(),
      "database/migrations/001_captain_baseline.sql"
    ), "utf8");

    const constraintReplacement = migration.indexOf(
      "status text not null check (status in ('active', 'scheduled', 'paused', 'completed'))"
    );
    expect(constraintReplacement).toBeGreaterThan(-1);
    expect(migration).not.toContain("set status = 'scheduled'");
  });
});
