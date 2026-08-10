import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Checkpoint notification kinds migration", () => {
  const migration = readFileSync(
    resolve(process.cwd(), "database/migrations/024_checkpoint_notification_kinds.sql"),
    "utf8"
  );

  it("allows progress checkpoint ack kinds", () => {
    expect(migration).toContain("drop constraint if exists notifications_kind_check");
    expect(migration).toContain("'plan_changed'");
    expect(migration).toContain("'tracking_paused'");
    expect(migration).toContain("'tracking_resumed'");
    expect(migration).toContain("'trip_closed'");
  });
});
