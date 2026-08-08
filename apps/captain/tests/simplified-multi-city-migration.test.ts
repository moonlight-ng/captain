import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

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
