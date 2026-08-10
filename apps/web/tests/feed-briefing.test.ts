import { afterEach, describe, expect, it, vi } from "vitest";

import { feedBriefing } from "../src/feed-briefing.js";
import type { Recommendation, TrackedPriceHistory, Watch } from "../src/domain.js";

const recommendation: Recommendation = {
  tripId: "trip-1",
  offerId: "offer-1",
  itineraryKey: "itin-1",
  score: 1,
  rankingMode: "balanced",
  summary: "BA BA123 · LOS → LHR · nonstop · 6h 30m · GBP 420",
  observedAt: "2026-08-09T12:00:00.000Z"
};

const watch: Watch = {
  status: "active",
  runStartedAt: "2026-08-01T00:00:00.000Z",
  runEndsAt: "2026-08-20T00:00:00.000Z",
  completedAt: null,
  checksCompleted: 3,
  nextCheckAt: "2026-08-10T12:00:00.000Z",
  lastCheckAt: "2026-08-09T12:00:00.000Z",
  lastManualRefreshAt: null,
  trackingStartsAt: null,
  baselineCompletedAt: null,
  activatedAt: "2026-08-01T00:00:00.000Z",
  lastUserActivityAt: "2026-08-09T12:00:00.000Z",
  priceRiseItineraryKey: null,
  priceRiseArmed: false,
  delayedAt: null,
  delayReason: null
};

const tracked = (verdict: TrackedPriceHistory["verdict"], headline: string): TrackedPriceHistory => ({
  itineraryKey: "itin-1",
  currency: "GBP",
  points: [{ day: "2026-08-09", price: 420, observedAt: "2026-08-09T12:00:00.000Z" }],
  current: 420,
  low: 400,
  high: 500,
  average: 450,
  changeSinceStart: -20,
  changeSinceLastCheck: 0,
  positionInRange: 0.2,
  daysTracked: 5,
  daysToDeparture: 20,
  verdict,
  headline
});

afterEach(() => {
  vi.useRealTimers();
});

describe("feedBriefing", () => {
  it("writes prose for a pick plus next check instead of the metrics summary", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-09T13:00:00.000Z"));

    const briefing = feedBriefing({
      recommendation,
      pickLabel: "British Airways at £420",
      tracked: null,
      watch,
      watchingCount: 1
    });

    expect(briefing?.prose).toBe(
      "Captain’s pick is British Airways at £420 on the balanced ranking. Next check In 23h."
    );
    expect(briefing?.prose).not.toContain("BA BA123");
    expect(briefing?.observedAt).toBe(recommendation.observedAt);
  });

  it("leans on the price verdict for state and next step", () => {
    const briefing = feedBriefing({
      recommendation,
      pickLabel: "British Airways at £420",
      tracked: tracked("book_now", "Cheapest this flight has been. A good moment to buy."),
      watch,
      watchingCount: 1
    });

    expect(briefing?.prose).toBe(
      "Captain’s pick is British Airways at £420. Cheapest this flight has been. A good moment to buy. Open the flight if you want to lock it in."
    );
  });

  it("covers watching without a pick yet", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-09T13:00:00.000Z"));

    const briefing = feedBriefing({
      recommendation: null,
      pickLabel: null,
      tracked: null,
      watch,
      watchingCount: 2
    });

    expect(briefing?.prose).toBe("Watching 2 flights. Next check In 23h.");
  });
});
