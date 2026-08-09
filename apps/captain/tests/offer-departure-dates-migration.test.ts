import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("Offer departure-date retention migration", () => {
  it("keeps departureDates in both fresh and upgraded databases", () => {
    const baseline = readFileSync(
      resolve(process.cwd(), "database/migrations/001_captain_baseline.sql"),
      "utf8"
    );
    const upgrade = readFileSync(
      resolve(process.cwd(), "database/migrations/020_retain_offer_departure_dates.sql"),
      "utf8"
    );

    expect(baseline).toContain("'departureDates', coalesce(new.snapshot -> 'departureDates'");
    expect(upgrade).toContain("create or replace function captain.compact_offer_snapshot()");
    expect(upgrade).toContain("'departureDates', coalesce(new.snapshot -> 'departureDates'");
  });
});
