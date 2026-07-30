import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("Smart notifications migration", () => {
  it("allows the scheduled watch status before backfilling it", () => {
    const migration = readFileSync(join(
      process.cwd(),
      "migrations/019_smart_notifications.sql"
    ), "utf8");

    const constraintReplacement = migration.indexOf(
      "check (status in ('active', 'scheduled', 'paused', 'completed'))"
    );
    const scheduledBackfill = migration.indexOf("set status = 'scheduled'");

    expect(constraintReplacement).toBeGreaterThan(-1);
    expect(scheduledBackfill).toBeGreaterThan(-1);
    expect(constraintReplacement).toBeLessThan(scheduledBackfill);
  });
});
