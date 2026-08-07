import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { DEFAULT_PROFILE, notificationModeSchema } from "@agents/flight-domain";

describe("Captain speaks only on change migration", () => {
  const migration = readFileSync(
    resolve(process.cwd(), "database/migrations/015_captain_speaks_only_on_change.sql"),
    "utf8"
  );

  it("leaves no notification whose kind the new constraint forbids", () => {
    // The check runs against delivered rows too, so a single sent digest left
    // behind would fail the migration.
    expect(migration.indexOf("delete from captain.notifications where kind = 'daily_digest'"))
      .toBeLessThan(migration.indexOf("add constraint notifications_kind_check"));
    expect(migration).not.toMatch(/add constraint notifications_kind_check[\s\S]*daily_digest/u);
  });

  it("moves every digest subscriber onto the one remaining mode", () => {
    expect(migration).toContain("set notification_mode = 'changes_only'");
    expect(migration.indexOf("where notification_mode in ('smart', 'daily')"))
      .toBeLessThan(migration.indexOf("check (notification_mode in ('changes_only', 'off'))"));
  });

  it("drops both the inline baseline constraint and the prototype-named one", () => {
    for (const name of [
      "captain_profiles_notification_mode_check",
      "traveller_profiles_notification_mode_check"
    ]) {
      expect(migration).toContain(`drop constraint if exists ${name}`);
    }
  });

  it("clears changes that were being held back for a digest that will never send", () => {
    expect(migration).toContain("snapshot - 'pendingDigestChange'");
  });

  it("removes the columns that only existed to schedule the digest", () => {
    expect(migration).toContain("drop column if exists digest_hour_local");
    expect(migration).toContain("drop column if exists last_digest_at");
  });

  it("matches the modes the application will actually write", () => {
    expect(notificationModeSchema.options).toEqual(["changes_only", "off"]);
    expect(DEFAULT_PROFILE.notificationMode).toBe("changes_only");
    expect(migration).toContain("alter column notification_mode set default 'changes_only'");
  });
});
