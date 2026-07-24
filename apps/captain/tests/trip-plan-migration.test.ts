import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Trip plan draft migration", () => {
  it("creates tenant-scoped, revisioned drafts with one open draft and unique receipts", () => {
    const migration = readFileSync(join(
      process.cwd(),
      "migrations/008_trip_plan_drafts.sql"
    ), "utf8");
    expect(migration).toContain("create table if not exists captain.trip_plan_drafts");
    expect(migration).toContain("user_id uuid not null references captain.users");
    expect(migration).toContain("captain_trip_plan_drafts_one_open_idx");
    expect(migration).toContain("captain_trip_plan_drafts_expiry_idx");
    expect(migration).toContain("captain_trip_plan_drafts_trip_idx");
    expect(migration).toContain("captain_trip_plan_drafts_idempotency_idx");
  });
});
