import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Trip plan draft migration", () => {
  it("creates tenant-scoped, revisioned drafts with one open draft and unique receipts", () => {
    const migration = readFileSync(join(
      process.cwd(),
      "database/migrations/001_captain_baseline.sql"
    ), "utf8");
    expect(migration).toContain("create table captain.trip_plan_drafts");
    expect(migration).toContain("user_id uuid not null references captain.users");
    expect(migration).toContain("captain_trip_plan_drafts_one_open_idx");
    expect(migration).toContain("captain_trip_plan_drafts_expiry_idx");
    expect(migration).toContain("captain_trip_plan_drafts_trip_idx");
    expect(migration).toContain("captain_trip_plan_drafts_idempotency_idx");
  });

  it("transactionally converts v2 drafts to canonical v3 state and retires merge columns", () => {
    const migration = readFileSync(join(
      process.cwd(),
      "database/migrations/003_trip_planner_v3.sql"
    ), "utf8");
    expect(migration).toContain("add column draft_state jsonb");
    expect(migration).toContain("'version', 3");
    expect(migration).toContain("'kind', 'exact'");
    expect(migration).toContain("confirmation_snapshot = draft.plan");
    expect(migration).toContain("alter column draft_state set not null");
    expect(migration).toContain("drop column partial");
    expect(migration).toContain("drop column turn_state");
  });
});
