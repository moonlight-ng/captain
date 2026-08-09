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
    expect(orderedTripTabs(trip)).toEqual(["plan", "flights", "feed"]);
    expect(orderedTripTabs(trip).map((tab) => TRIP_TAB_LABELS[tab])).toEqual([
      "Plan",
      "Flights",
      "Feed"
    ]);
  });

  it.each(["tracking", "recommended", "paused"] as const)(
    "opens a complete %s trip on Feed and puts Feed first",
    (status) => {
      const trip = { status };
      expect(defaultTripTab(trip)).toBe("feed");
      expect(orderedTripTabs(trip)).toEqual(["feed", "flights", "plan"]);
    }
  );

  it("uses Feed when there is no incomplete trip", () => {
    expect(defaultTripTab(null)).toBe("feed");
  });
});
