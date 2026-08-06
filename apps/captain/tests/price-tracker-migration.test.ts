import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Price tracker migration", () => {
  const migration = readFileSync(
    resolve(process.cwd(), "database/migrations/012_price_tracker_only.sql"),
    "utf8"
  );

  it("drops every table that existed to support a purchase", () => {
    for (const table of [
      "payment_card_deletions",
      "payment_card_setup_intents",
      "payment_methods",
      "trip_passengers",
      "passengers"
    ]) {
      expect(migration).toContain(`drop table if exists captain.${table}`);
    }
    expect(migration).toContain("drop function if exists captain.enforce_payment_method_limit()");
    expect(migration).toContain("drop function if exists captain.enforce_passenger_limit()");
  });

  it("drops the triggers before the functions they call", () => {
    const trigger = migration.indexOf("drop trigger if exists captain_payment_methods_enforce_limit");
    const fn = migration.indexOf("drop function if exists captain.enforce_payment_method_limit()");
    expect(trigger).toBeGreaterThan(-1);
    expect(fn).toBeGreaterThan(trigger);
  });

  it("drops the tables before the columns that could reference them", () => {
    expect(migration.indexOf("drop table if exists captain.passengers"))
      .toBeLessThan(migration.indexOf("alter table captain.traveller_profiles"));
  });

  it("leaves pgcrypto installed rather than risking a failed release command", () => {
    expect(migration).not.toContain("drop extension if exists pgcrypto;");
  });

  it("removes the cadence constraint before the column it constrains", () => {
    const constraint = migration.indexOf("drop constraint if exists captain_watches_cadence_six_hours_check");
    const column = migration.indexOf("drop column if exists cadence_hours");
    expect(constraint).toBeGreaterThan(-1);
    expect(column).toBeGreaterThan(constraint);
  });

  it("extends live runs to departure before dropping the duration column", () => {
    const backfill = migration.indexOf("update captain.watches watch");
    const drop = migration.indexOf("drop column if exists tracking_duration_hours");
    expect(backfill).toBeGreaterThan(-1);
    expect(drop).toBeGreaterThan(backfill);
    // The window constraint from migration 009 still applies, so every
    // backfilled run has to end at least a day out.
    expect(migration).toContain("now() + interval '1 day'");
    expect(migration).toContain("now() + interval '400 days'");
  });

  it("reads the departure as UTC, matching trackingRunEndsAt", () => {
    expect(migration).toContain("|| 'T23:59:59.999Z')::timestamptz");
  });

  it("only backfills watches whose departure date is readable", () => {
    expect(migration).toContain("~ '^\\d{4}-\\d{2}-\\d{2}$'");
  });

  it("clears every check-in notification, not just the undelivered ones", () => {
    // The tightened constraint is validated against delivered rows too.
    expect(migration).toContain(
      "delete from captain.notifications where kind in ('tracking_checkin', 'tracking_paused');"
    );
    const remove = migration.indexOf("delete from captain.notifications where kind in");
    const constrain = migration.indexOf("add constraint notifications_kind_check");
    expect(remove).toBeLessThan(constrain);
  });

  it("narrows the notification kinds to those Captain still sends", () => {
    const constraint = migration.slice(migration.indexOf("add constraint notifications_kind_check"));
    expect(constraint).not.toContain("tracking_checkin");
    expect(constraint).not.toContain("tracking_paused");
    for (const kind of ["price_rise", "daily_digest", "tracking_summary", "new_best"]) {
      expect(constraint).toContain(kind);
    }
  });
});
