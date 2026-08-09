import { describe, expect, it } from "vitest";

import {
  TRIP_TAB_LABELS,
  defaultTripTab,
  orderedTripTabs
} from "../src/trip-tabs.js";

describe("trip navigation", () => {
  it("opens an incomplete draft on Plan and puts Plan first", () => {
    const trip = { status: "draft" as const };
    expect(defaultTripTab(trip)).toBe("plan");
    expect(orderedTripTabs(trip)).toEqual(["plan", "flights", "watchlist"]);
    expect(orderedTripTabs(trip).map((tab) => TRIP_TAB_LABELS[tab])).toEqual([
      "Plan",
      "Flights",
      "Watchlist"
    ]);
  });

  it.each(["tracking", "recommended", "paused"] as const)(
    "opens a complete %s trip on Watchlist and puts Watchlist first",
    (status) => {
      const trip = { status };
      expect(defaultTripTab(trip)).toBe("watchlist");
      expect(orderedTripTabs(trip)).toEqual(["watchlist", "flights", "plan"]);
    }
  );

  it("uses Watchlist when there is no incomplete trip", () => {
    expect(defaultTripTab(null)).toBe("watchlist");
  });
});
