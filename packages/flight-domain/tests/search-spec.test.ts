import { describe, expect, it } from "vitest";

import { buildSearchSpecs, searchSpecKey } from "../src/index.js";

const brief = {
  originAirports: ["LHR"],
  destinationAirports: ["BER"],
  tripType: "round_trip" as const,
  departureWindow: { start: "2026-09-10", end: "2026-09-10" },
  stayNights: { minimum: 3, preferred: 4, maximum: 5 },
  travellers: { adults: 1 as const, childrenAges: [] as [], infants: 0 as const },
  cabin: "economy" as const,
  maxStops: 1,
  currency: "GBP",
  maximumPrice: null,
  preferredAirlines: [],
  excludedAirlines: [],
  context: ""
};

describe("shared Duffel search specifications", () => {
  it("produces a stable provider-neutral key", () => {
    const request = buildSearchSpecs(brief)[0]!.request;
    expect(searchSpecKey(request)).toBe(searchSpecKey({ ...request }));
    expect(request.provider).toBe("official_duffel");
    expect(request.passenger).toEqual({ adults: 1, childrenAges: [], infants: 0 });
  });

  it("uses one bounded specification for a Trip", () => {
    expect(buildSearchSpecs({
      ...brief,
      originAirports: ["LHR", "LGW", "LCY"],
      destinationAirports: ["BER", "FRA", "MUC"],
      departureWindow: { start: "2026-09-01", end: "2026-09-30" }
    })).toHaveLength(1);
  });

  it("keeps ordered multi-city legs in one request", () => {
    const [spec] = buildSearchSpecs({
      ...brief,
      originAirports: ["LOS"],
      destinationAirports: ["LON"],
      tripType: "multi_city",
      departureWindow: { start: "2026-08-16", end: "2026-08-16" },
      stayNights: null,
      legs: [
        {
          originAirports: ["LOS"],
          destinationAirports: ["NYC"],
          departureWindow: { start: "2026-08-16", end: "2026-08-16" }
        },
        {
          originAirports: ["NYC"],
          destinationAirports: ["LON"],
          departureWindow: { start: "2026-08-23", end: "2026-08-23" }
        }
      ]
    });

    expect(spec?.request.slices).toEqual([
      {
        originAirports: ["LOS"],
        destinationAirports: ["NYC"],
        departureStart: "2026-08-16",
        departureEnd: "2026-08-16"
      },
      {
        originAirports: ["NYC"],
        destinationAirports: ["LON"],
        departureStart: "2026-08-23",
        departureEnd: "2026-08-23"
      }
    ]);
  });

  it("preserves Duffel metropolitan codes so all city airports are searched", () => {
    const [spec] = buildSearchSpecs({
      ...brief,
      originAirports: ["LOS"],
      destinationAirports: ["LON"],
      tripType: "one_way",
      stayNights: null
    });

    expect(spec?.request.slices[0]).toMatchObject({
      originAirports: ["LOS"],
      destinationAirports: ["LON"]
    });
  });
});
