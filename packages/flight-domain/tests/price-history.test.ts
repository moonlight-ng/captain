import { describe, expect, it } from "vitest";

import {
  isMeaningfulMove,
  summarizePriceHistory,
  toDailyPoints
} from "../src/price-history.js";

const NOW = new Date("2026-08-10T12:00:00Z");

describe("daily price points", () => {
  it("keeps the lowest fare seen on each day", () => {
    expect(toDailyPoints([
      { price: 300, observedAt: "2026-08-01T06:00:00Z" },
      { price: 250, observedAt: "2026-08-01T18:00:00Z" },
      { price: 280, observedAt: "2026-08-02T06:00:00Z" }
    ])).toEqual([
      { day: "2026-08-01", price: 250, observedAt: "2026-08-01T18:00:00.000Z" },
      { day: "2026-08-02", price: 280, observedAt: "2026-08-02T06:00:00.000Z" }
    ]);
  });

  it("drops observations it cannot read rather than charting a NaN", () => {
    expect(toDailyPoints([
      { price: Number.NaN, observedAt: "2026-08-01T06:00:00Z" },
      { price: 250, observedAt: "not a date" },
      { price: 250, observedAt: "2026-08-01T18:00:00Z" }
    ])).toHaveLength(1);
  });
});

describe("price history summary", () => {
  it("returns nothing when no price has been observed", () => {
    expect(summarizePriceHistory({ observations: [], currency: "GBP", now: NOW })).toBeNull();
  });

  it("will not call a trend from a single day", () => {
    const summary = summarizePriceHistory({
      observations: [{ price: 400, observedAt: "2026-08-10T06:00:00Z" }],
      currency: "GBP",
      departureDate: "2026-12-01",
      now: NOW
    });
    expect(summary).toMatchObject({ verdict: "holding", daysTracked: 1 });
    expect(summary?.headline).toContain("another day");
  });

  it("calls the bottom of the range a moment to buy", () => {
    const summary = summarizePriceHistory({
      observations: series([500, 560, 610, 480]),
      currency: "GBP",
      departureDate: "2026-12-01",
      now: NOW
    })!;
    expect(summary).toMatchObject({
      verdict: "book_now",
      current: 480,
      low: 480,
      high: 610,
      positionInRange: 0,
      changeSinceStart: -20
    });
    expect(summary.headline).toContain("Cheapest");
  });

  it("says wait near the top of the range while there is time to wait", () => {
    const summary = summarizePriceHistory({
      observations: series([400, 450, 600]),
      currency: "GBP",
      departureDate: "2026-12-01",
      now: NOW
    })!;
    expect(summary.verdict).toBe("wait");
    expect(summary.changeSinceLastCheck).toBe(150);
  });

  it("stops telling people to wait once departure is close", () => {
    // Same series, but the flight leaves in a week. There is no longer a
    // meaningful chance to catch a better price, so waiting is bad advice.
    expect(summarizePriceHistory({
      observations: series([400, 450, 600]),
      currency: "GBP",
      departureDate: "2026-08-16",
      now: NOW
    })!.verdict).toBe("holding");
  });

  it("notes a below-average fare without overclaiming", () => {
    const summary = summarizePriceHistory({
      observations: series([400, 700, 800, 520]),
      currency: "GBP",
      departureDate: "2026-12-01",
      now: NOW
    })!;
    expect(summary.verdict).toBe("good_price");
    expect(summary.headline).toContain("Below its average");
  });

  it("counts days to departure from the calendar day, not the clock", () => {
    expect(summarizePriceHistory({
      observations: series([400, 420]),
      currency: "GBP",
      departureDate: "2026-08-20",
      now: NOW
    })!.daysToDeparture).toBe(10);
  });
});

describe("meaningful moves", () => {
  it("ignores small moves in both relative and absolute terms", () => {
    expect(isMeaningfulMove(500, 520)).toBe(false);
    expect(isMeaningfulMove(100, 106)).toBe(false);
    expect(isMeaningfulMove(500, 560)).toBe(true);
    expect(isMeaningfulMove(500, 440)).toBe(true);
  });
});

/** One observation a day, ending today. */
function series(prices: number[]): Array<{ price: number; observedAt: string }> {
  const start = Date.parse("2026-08-10T06:00:00Z") - (prices.length - 1) * 86_400_000;
  return prices.map((price, index) => ({
    price,
    observedAt: new Date(start + index * 86_400_000).toISOString()
  }));
}
