import { DEFAULT_PROFILE, notificationModeSchema } from "@agents/flight-domain";
import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";

// from checkpoint-notification-migration.test.ts
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

describe("Fare digest jobs migration", () => {
  const migration = readFileSync(
    resolve(process.cwd(), "database/migrations/029_fare_digest_jobs.sql"),
    "utf8"
  );

  it("adds an opt-in watch purpose and its daily notification kind", () => {
    expect(migration).toContain("purpose text not null default 'price_changes'");
    expect(migration).toContain("purpose in ('price_changes', 'fare_digest')");
    expect(migration).toContain("'fare_digest'");
    expect(migration).toContain("digest_hour_local between 0 and 23");
  });
});

// from conversation-summary-migration.test.ts
describe("Conversation summary migration", () => {
  const migration = readFileSync(
    resolve(process.cwd(), "database/migrations/026_conversation_summary.sql"),
    "utf8"
  );

  it("adds resumable summary markers without turning them into an FK", () => {
    expect(migration).toContain("add column if not exists summary_updated_at timestamptz");
    expect(migration).toContain("add column if not exists summary_through_message_id uuid");
    expect(migration).toContain("Not an FK: outlives message retention");
    expect(migration).not.toMatch(/references\s+captain\.messages/iu);
  });
});

describe("Preferred language migration", () => {
  const migration = readFileSync(
    resolve(process.cwd(), "database/migrations/028_preferred_language.sql"),
    "utf8"
  );

  it("keeps English as an eligible default until a response establishes a language", () => {
    expect(DEFAULT_PROFILE.preferredLanguage).toBe("en");
    expect(DEFAULT_PROFILE.preferredLanguageSource).toBe("default");
    expect(migration).toContain("preferred_language text not null default 'en'");
    expect(migration).toContain("'default', 'detected', 'user'");
  });
});

// from daily-alert-cap-migration.test.ts
describe("Daily alert cap migration", () => {
  const migration = readFileSync(
    resolve(process.cwd(), "database/migrations/014_daily_alert_cap_defaults_to_one.sql"),
    "utf8"
  );

  it("moves the column default to the cap the domain already applies", () => {
    expect(DEFAULT_PROFILE.maxAlertsPerDay).toBe(1);
    expect(migration).toContain("alter column max_alerts_per_day set default 1");
  });

  it("leaves travellers who raised their own cap alone", () => {
    expect(migration).not.toMatch(/update\s+captain\.traveller_profiles/iu);
  });
});

// from feedback-route-migration.test.ts
describe("Feedback route migration", () => {
  const migration = readFileSync(
    resolve(process.cwd(), "database/migrations/016_feedback_login_route.sql"),
    "utf8"
  );

  it("allows a single-use login token to open the feedback form", () => {
    expect(migration).toContain("drop constraint if exists login_tokens_redirect_path_check");
    expect(migration).toContain("'/feedback'");
  });
});

// from multi-city-runtime-grants-migration.test.ts
describe("Multi-city runtime grants migration", () => {
  const migration = readFileSync(
    resolve(
      process.cwd(),
      "database/migrations/019_grant_simplified_multi_city_runtime_access.sql"
    ),
    "utf8"
  );

  it("grants and secures every normalized multi-city table", () => {
    for (const table of ["trip_cities", "trip_legs", "leg_search_snapshots"]) {
      expect(migration).toContain(`'${table}'`);
    }
    expect(migration).toContain("alter table captain.%I enable row level security");
    expect(migration).toContain("create policy captain_runtime_full_access");
    expect(migration).toContain("grant select, insert, update, delete");
    expect(migration).toContain("alter table captain.%I owner to captain_migrator");
  });

  it("makes missing runtime table grants block a release", () => {
    const release = readFileSync(
      resolve(process.cwd(), "scripts/release.mjs"),
      "utf8"
    );
    expect(release).toContain("await assertRuntimeDatabasePermissions()");
    for (const privilege of ["select", "insert", "update", "delete"]) {
      expect(release).toContain(`has_table_privilege(relation.oid, '${privilege}')`);
    }
    expect(release).toContain("Captain runtime role is missing table privileges on:");
  });
});

// from offer-departure-dates-migration.test.ts
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

// from price-tracker-migration.test.ts
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

// from profile-route-migration.test.ts
describe("Profile route migration", () => {
  const migration = readFileSync(
    resolve(process.cwd(), "database/migrations/008_profile_route.sql"),
    "utf8"
  );

  it("allows secure login tokens to target the canonical profile route", () => {
    expect(migration).toContain("drop constraint if exists login_tokens_redirect_path_check");
    expect(migration).toContain(
      "check (redirect_path in ('/trip', '/profile', '/preferences', '/settings', '/payment', '/travellers'))"
    );
  });
});

// from simplified-multi-city-migration.test.ts
describe("Simplified multi-city migration", () => {
  const migration = readFileSync(
    resolve(process.cwd(), "database/migrations/017_simplified_multi_city.sql"),
    "utf8"
  );

  it("adds normalized city, leg, and manual-search snapshot storage", () => {
    expect(migration).toContain("create table captain.trip_cities");
    expect(migration).toContain("create table captain.trip_legs");
    expect(migration).toContain("create table captain.leg_search_snapshots");
    expect(migration).toContain("unique (trip_id, position)");
    expect(migration).toContain("latest_search_id uuid");
    expect(migration).toContain("selected_flight_key text");
  });

  it("backfills one-way, round-trip, and multi-city route shapes", () => {
    expect(migration).toContain("trip.brief ->> 'tripType' = 'multi_city'");
    expect(migration).toContain("trip.brief ->> 'tripType' in ('one_way', 'round_trip')");
    expect(migration).toContain("trip.brief ->> 'tripType' = 'round_trip'");
    expect(migration).toContain("trip.brief #>> '{stayNights,minimum}'");
    expect(migration).toContain("trip.brief #>> '{stayNights,maximum}'");
  });

  it("retires scheduled Watches without deleting legacy fare history", () => {
    expect(migration).toContain("update captain.watches");
    expect(migration).toContain("status = 'completed'");
    expect(migration).toContain("next_check_at = null");
    expect(migration).toContain("where status in ('tracking', 'recommended', 'paused')");
    expect(migration).not.toContain("delete from captain.offers");
    expect(migration).not.toContain("delete from captain.price_observations");
    expect(migration).not.toContain("delete from captain.itineraries");
  });
});

// from smart-notifications-migration.test.ts
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

// from speaks-only-on-change-migration.test.ts
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

// from tracking-started-notification-migration.test.ts
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

// from traveller-facts-migration.test.ts
describe("Traveller facts migration", () => {
  const migration = readFileSync(
    resolve(process.cwd(), "database/migrations/027_traveller_facts.sql"),
    "utf8"
  );

  it("creates durable facts with evidence and a dismissible status", () => {
    expect(migration).toContain("create table captain.traveller_facts");
    expect(migration).toContain("'home_airport'");
    expect(migration).toContain("'cabin_preference'");
    expect(migration).toContain("'airline_affinity'");
    expect(migration).toContain("'routine_route'");
    expect(migration).toContain("'constraint'");
    expect(migration).toContain("'context'");
    expect(migration).toContain("evidence text not null");
    expect(migration).toContain("'active'");
    expect(migration).toContain("'dismissed'");
    expect(migration).toContain("unique (user_id, kind, value)");
  });

  it("grants the runtime role and scopes RLS to it", () => {
    expect(migration).toContain("enable row level security");
    expect(migration).toContain("grant select, insert, update, delete on captain.traveller_facts to captain_runtime");
  });
});

// from trip-ambiguity-migration.test.ts
describe("Trip ambiguity question migration", () => {
  const migration = readFileSync(
    resolve(process.cwd(), "database/migrations/018_cap_trip_ambiguity_questions.sql"),
    "utf8"
  );

  it("backfills open drafts and updates the database default", () => {
    expect(migration).toContain("jsonb_set(draft_state, '{questionsAsked}', '0'::jsonb, true)");
    expect(migration).toContain("where not (draft_state ? 'questionsAsked')");
    expect(migration).toContain('"questionsAsked": 0');
  });
});

// from trip-plan-migration.test.ts
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

// from unified-settings-migration.test.ts
describe("Unified settings route migration", () => {
  const migration = readFileSync(
    resolve(process.cwd(), "database/migrations/007_unified_settings_route.sql"),
    "utf8"
  );

  it("allows login tokens to target the canonical settings route", () => {
    expect(migration).toContain("drop constraint if exists login_tokens_redirect_path_check");
    expect(migration).toContain(
      "check (redirect_path in ('/trip', '/preferences', '/settings', '/payment', '/travellers'))"
    );
  });
});

// from watch-retention-migration.test.ts
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
