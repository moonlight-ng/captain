import { describe, expect, it } from "vitest";

import type { Trip, Watch } from "../src/domain.js";
import { shouldAutoSearchOnOpen, stageLabel, tripStage } from "../src/trip-stage.js";

describe("trip stage", () => {
  it("reports a stopped trip before anything else", () => {
    expect(tripStage({ trip: null, watch: watch() })).toBe("stopped");
  });

  it("prefers a pause over a stale or running watch", () => {
    expect(tripStage({ trip: trip({ status: "paused" }), watch: watch({ status: "completed" }) }))
      .toBe("paused");
    expect(tripStage({ trip: trip(), watch: watch({ status: "paused" }) })).toBe("paused");
  });

  it("marks a finished run stale", () => {
    expect(tripStage({ trip: trip(), watch: watch({ status: "completed" }) })).toBe("stale");
  });

  it("searches only while provider work is queued or running", () => {
    expect(tripStage({ trip: trip(), watch: watch(), search: search("queued") })).toBe("searching");
    expect(tripStage({ trip: trip(), watch: watch(), search: search("running") })).toBe("searching");
    expect(tripStage({ trip: trip(), watch: watch(), searchBusy: true })).toBe("searching");
  });

  it("does not infer a pending search from stale watch timestamps", () => {
    expect(tripStage({
      trip: trip(),
      watch: watch({
        lastCheckAt: "2026-08-04T08:00:00.000Z",
        lastManualRefreshAt: "2026-08-04T09:00:00.000Z"
      }),
      search: search("idle")
    })).toBe("tracking");
  });

  it("checks prices whenever a trip is opened, independently of automation state", () => {
    expect(shouldAutoSearchOnOpen({ trip: trip(), search: search("idle") })).toBe(true);
    expect(shouldAutoSearchOnOpen({
      trip: trip({ status: "paused" }),
      search: search("idle")
    })).toBe(true);
  });

  it("does not search without a trip", () => {
    expect(shouldAutoSearchOnOpen({ trip: null, search: search("idle") })).toBe(false);
  });

  it("reuses provider work already queued for the trip", () => {
    expect(shouldAutoSearchOnOpen({ trip: trip(), search: search("queued") })).toBe(false);
    expect(shouldAutoSearchOnOpen({ trip: trip(), search: search("running") })).toBe(false);
  });

  it("labels a tracking stage with check freshness", () => {
    expect(stageLabel("stale")).toBe("Prices stale");
    expect(stageLabel("stopped")).toBe("");
    expect(stageLabel("tracking", watch())).toMatch(/^Checked /u);
    expect(stageLabel("tracking", null)).toBe("Tracking");
  });
});

function dayAway(): string {
  return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
}

function search(status: "idle" | "queued" | "running") {
  return {
    status,
    requestedAt: status === "idle" ? null : "2026-08-04T09:00:00.000Z",
    startedAt: status === "running" ? "2026-08-04T09:00:01.000Z" : null
  };
}

function trip(overrides: Partial<Trip> = {}): Trip {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    title: "LOS → LHR",
    status: "tracking",
    version: 3,
    brief: {
      originAirports: ["LOS"],
      destinationAirports: ["LHR"],
      tripType: "round_trip",
      departureWindow: { start: "2026-09-01", end: "2026-09-07" },
      stayNights: { minimum: 5, preferred: 7, maximum: 10 },
      travellers: { adults: 1, childrenAges: [], infants: 0 },
      cabin: "economy",
      maxStops: 1,
      currency: "GBP",
      maximumPrice: null,
      preferredAirlines: [],
      excludedAirlines: [],
      context: ""
    },
    createdAt: "2026-08-01T08:00:00.000Z",
    updatedAt: "2026-08-04T08:00:00.000Z",
    ...overrides
  };
}

function watch(overrides: Partial<Watch> = {}): Watch {
  const hourAway = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  return {
    status: "active",
        runStartedAt: "2026-08-04T00:00:00.000Z",
    runEndsAt: dayAway(),
    completedAt: null,
    checksCompleted: 2,
    nextCheckAt: hourAway,
    lastCheckAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    lastManualRefreshAt: null,
    trackingStartsAt: null,
    baselineCompletedAt: null,
    activatedAt: "2026-08-04T00:00:00.000Z",
    lastUserActivityAt: "2026-08-04T00:00:00.000Z",
        priceRiseItineraryKey: null,
    priceRiseArmed: false,
    delayedAt: null,
    delayReason: null,
    ...overrides
  };
}
