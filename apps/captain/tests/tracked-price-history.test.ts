import { describe, expect, it } from "vitest";

import { toTrackedPriceHistory } from "../services/trips/tracked-price-history.js";

describe("tracked price history API payload", () => {
  it("stays null after a flight is selected but before its first price observation", () => {
    expect(toTrackedPriceHistory({
      itineraryKey: "BA-75|2026-09-01",
      currency: "GBP",
      observations: []
    }, "2026-09-01")).toBeNull();
  });

  it("returns a complete chart payload once the first observation exists", () => {
    const history = toTrackedPriceHistory({
      itineraryKey: "BA-75|2026-09-01",
      currency: "GBP",
      observations: [{ price: 640, observedAt: "2026-08-07T10:00:00.000Z" }]
    }, "2026-09-01");

    expect(history).toMatchObject({
      itineraryKey: "BA-75|2026-09-01",
      currency: "GBP",
      current: 640,
      low: 640,
      high: 640,
      points: [{ day: "2026-08-07", price: 640 }]
    });
  });
});
