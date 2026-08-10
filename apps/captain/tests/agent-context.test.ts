import { describe, expect, it } from "vitest";

import type { Trip, TripGraph } from "@agents/flight-domain";

import { legIndex, tripDigest } from "../agent/instructions/context.js";
import { defaultTestBrief } from "./support.js";

const TRIP_ID = "11111111-1111-4111-8111-111111111111";
const LAGOS_ID = "22222222-2222-4222-8222-222222222222";
const LONDON_ID = "33333333-3333-4333-8333-333333333333";
const LEG_ONE = "44444444-4444-4444-8444-444444444444";
const LEG_TWO = "55555555-5555-4555-8555-555555555555";

function trip(overrides: Partial<Trip> = {}): Trip {
  return {
    id: TRIP_ID,
    title: "Lagos to London",
    status: "tracking",
    version: 1,
    brief: defaultTestBrief({ maxStops: 1, maximumPrice: 900 }),
    ...overrides
  } as unknown as Trip;
}

function graph(): TripGraph {
  return {
    cities: [
      {
        id: LAGOS_ID,
        tripId: TRIP_ID,
        position: 0,
        label: "Lagos",
        airportCodes: ["LOS"],
        arrivalWindow: null,
        departureWindow: null
      },
      {
        id: LONDON_ID,
        tripId: TRIP_ID,
        position: 1,
        label: "London",
        airportCodes: ["LON"],
        arrivalWindow: null,
        departureWindow: null
      }
    ],
    legs: [
      {
        id: LEG_TWO,
        tripId: TRIP_ID,
        position: 1,
        originCityId: LONDON_ID,
        destinationCityId: LAGOS_ID,
        departureWindow: { start: "2026-09-13", end: "2026-09-13" },
        arriveBy: null,
        selectedFlightKey: null,
        latestSearchId: null
      },
      {
        id: LEG_ONE,
        tripId: TRIP_ID,
        position: 0,
        originCityId: LAGOS_ID,
        destinationCityId: LONDON_ID,
        departureWindow: { start: "2026-09-01", end: "2026-09-07" },
        arriveBy: "2026-09-08",
        selectedFlightKey: "some-flight-key",
        latestSearchId: null
      }
    ]
  };
}

describe("agent trip context", () => {
  // search_trip_leg needs a legId, which used to be reachable only by calling
  // get_trip first. Carrying the index into context is what lets "best day to
  // fly that week" be answered in one call instead of asked back about.
  it("gives every leg an id the fare tool can be called with, in route order", () => {
    const index = legIndex(graph());
    const lines = index.split("\n");

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(`legId: ${LEG_ONE}`);
    expect(lines[0]).toContain("Lagos (LOS) → London (LON)");
    expect(lines[0]).toContain("depart 2026-09-01 to 2026-09-07");
    expect(lines[0]).toContain("arrive by 2026-09-08");
    expect(lines[0]).toContain("a flight is selected");
    // Declared second, positioned second — the index is ordered by the route,
    // not by whatever order the store returned.
    expect(lines[1]).toContain(`legId: ${LEG_TWO}`);
    expect(lines[1]).toContain("no flight selected");
  });

  it("says none rather than nothing when there are no legs", () => {
    expect(legIndex(null)).toBe("none");
    expect(legIndex({ cities: [], legs: [] })).toBe("none");
  });

  it("keeps the constraints a fare answer depends on, and drops the rest", () => {
    const digest = tripDigest(trip());

    expect(digest).toContain("max stops: 1");
    expect(digest).toContain("currency: GBP");
    expect(digest).toContain("budget: 900");
    expect(digest).toContain("route: LHR→JFK");
    expect(digest).toContain("status: tracking");
    // The whole brief used to be JSON.stringify'd into every single turn.
    expect(digest).not.toContain("stayNights");
    expect(digest).not.toContain("preferredAirlines");
    expect(digest.length).toBeLessThan(400);
  });

  it("reports an absent trip without inventing one", () => {
    expect(tripDigest(null)).toBe("none");
  });
});
