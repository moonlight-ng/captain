import { describe, expect, it } from "vitest";

import { formatTripGoal, formatTripGoalTarget, tripGoalState, type TripGoalInput } from "../src/trip-goal.js";

function goalInput(overrides: Partial<TripGoalInput["brief"]> = {}, rankingMode: TripGoalInput["rankingMode"] = "balanced"): TripGoalInput {
  return {
    rankingMode,
    brief: {
      originAirports: ["LOS"],
      destinationAirports: ["LON"],
      tripType: "one_way",
      departureWindow: { start: "2026-09-10", end: "2026-09-10" },
      currency: "USD",
      maximumPrice: null,
      ...overrides
    }
  };
}

describe("trip goal", () => {
  it("states the route, the date and what Captain is ranking for", () => {
    expect(formatTripGoal(goalInput())).toBe(
      "Get you LOS → LON on 10 Sept for the best balance of fare and journey time, "
      + "using verified fares as prices change."
    );
  });

  it("prefers a stated fare ceiling over the ranking mode", () => {
    expect(formatTripGoal(goalInput({ maximumPrice: 500 }, "cheapest"))).toBe(
      "Get you LOS → LON on 10 Sept for under $500, using verified fares as prices change."
    );
    expect(formatTripGoalTarget(goalInput({ maximumPrice: 500 }, "cheapest")))
      .toBe("your $500 target");
  });

  it("names both ends of a departure window the traveller is choosing between", () => {
    expect(formatTripGoal(goalInput({
      departureWindow: { start: "2026-09-10", end: "2026-09-14" }
    }, "fastest"))).toBe(
      "Get you LOS → LON on 10 Sept–14 Sept for the fastest journey, "
      + "using verified fares as prices change."
    );
  });

  it("says a round trip comes back", () => {
    expect(formatTripGoal(goalInput({ tripType: "round_trip" })))
      .toContain("Get you LOS → LON and back on 10 Sept");
  });

  it("walks the whole multi-city route", () => {
    expect(formatTripGoal(goalInput({
      tripType: "multi_city",
      destinationAirports: ["JFK"],
      legs: [
        {
          originAirports: ["LOS"],
          destinationAirports: ["LON"],
          departureWindow: { start: "2026-09-10", end: "2026-09-10" }
        },
        {
          originAirports: ["LON"],
          destinationAirports: ["JFK"],
          departureWindow: { start: "2026-09-14", end: "2026-09-14" }
        }
      ]
    }))).toContain("Get you LOS → LON → JFK on 10 Sept");
  });

  it("moves from plan review to fare-pattern analysis only after confirmation", () => {
    expect(tripGoalState("draft")).toMatchObject({
      planConfirmation: "pending",
      phase: "plan_review"
    });
    expect(tripGoalState("tracking")).toMatchObject({
      planConfirmation: "achieved",
      phase: "fare_pattern_analysis"
    });
  });
});
