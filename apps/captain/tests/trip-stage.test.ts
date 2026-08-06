import { describe, expect, it } from "vitest";

import type { Trip, Watch } from "../src/domain.js";
import { shouldAutoSearchOnOpen, stageLabel, tripStage } from "../src/trip-stage.js";

describe("trip stage", () => {
  it("reports a stopped trip before anything else", () => {
    expect(tripStage({ trip: null, watch: watch(), booked: true })).toBe("stopped");
  });

  it("puts a booked trip past tracking, however the watch ended", () => {
    expect(tripStage({ trip: trip(), watch: watch({ status: "completed" }), booked: true }))
      .toBe("booked");
    expect(tripStage({ trip: trip({ status: "paused" }), watch: watch(), booked: true }))
      .toBe("booked");
  });

  it("prefers a pause over a stale or running watch", () => {
    expect(tripStage({ trip: trip({ status: "paused" }), watch: watch({ status: "completed" }) }))
      .toBe("paused");
    expect(tripStage({ trip: trip(), watch: watch({ status: "paused" }) })).toBe("paused");
  });

  it("marks a finished run stale", () => {
    expect(tripStage({ trip: trip(), watch: watch({ status: "completed" }) })).toBe("stale");
  });

  it("searches while a check is due, a refresh is pending, or none has run", () => {
    expect(tripStage({ trip: trip(), watch: watch({ lastCheckAt: null }) })).toBe("searching");
    expect(tripStage({
      trip: trip(),
      watch: watch({
        lastCheckAt: "2026-08-04T08:00:00.000Z",
        lastManualRefreshAt: "2026-08-04T09:00:00.000Z"
      })
    })).toBe("searching");
    expect(tripStage({ trip: trip(), watch: watch(), searchBusy: true })).toBe("searching");
  });

  it("tracks once a check has landed and the next one is far off", () => {
    expect(tripStage({ trip: trip(), watch: watch() })).toBe("tracking");
  });

  it("checks prices when a tracked trip is opened, whatever the schedule says", () => {
    expect(shouldAutoSearchOnOpen({ trip: trip(), watch: watch() })).toBe(true);
    expect(shouldAutoSearchOnOpen({
      trip: trip(),
      watch: watch({ status: "scheduled", nextCheckAt: dayAway(), trackingStartsAt: dayAway() })
    })).toBe(true);
  });

  it("leaves a stopped, finished, or booked trip alone on open", () => {
    expect(shouldAutoSearchOnOpen({ trip: null, watch: watch() })).toBe(false);
    expect(shouldAutoSearchOnOpen({ trip: trip(), watch: null })).toBe(false);
    expect(shouldAutoSearchOnOpen({ trip: trip(), watch: watch(), booked: true })).toBe(false);
    expect(shouldAutoSearchOnOpen({ trip: trip({ status: "paused" }), watch: watch() })).toBe(false);
    expect(shouldAutoSearchOnOpen({ trip: trip(), watch: watch({ status: "paused" }) })).toBe(false);
    expect(shouldAutoSearchOnOpen({ trip: trip(), watch: watch({ status: "completed" }) })).toBe(false);
  });

  it("skips the open check while a run is already searching", () => {
    expect(shouldAutoSearchOnOpen({ trip: trip(), watch: watch({ lastCheckAt: null }) })).toBe(false);
    expect(shouldAutoSearchOnOpen({
      trip: trip(),
      watch: watch({ nextCheckAt: new Date(Date.now() + 30_000).toISOString() })
    })).toBe(false);
  });

  it("leaves a run past its window to Track, which a refresh cannot restart", () => {
    expect(shouldAutoSearchOnOpen({
      trip: trip(),
      watch: watch({ runEndsAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() })
    })).toBe(false);
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
    cadenceHours: 6,
    trackingDurationHours: 72,
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
    checkInSentAt: null,
    autoPauseAt: null,
    priceRiseItineraryKey: null,
    priceRiseArmed: false,
    delayedAt: null,
    delayReason: null,
    ...overrides
  };
}
