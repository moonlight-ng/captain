import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Tracking-started progress notification migration", () => {
  const migration = readFileSync(
    resolve(process.cwd(), "database/migrations/022_tracking_started_progress_notification.sql"),
    "utf8"
  );

  it("allows the event-backed progress notification", () => {
    expect(migration).toContain("drop constraint if exists notifications_kind_check");
    expect(migration).toContain("'tracking_started'");
  });
});
