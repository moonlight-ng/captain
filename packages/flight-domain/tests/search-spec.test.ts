import { describe, expect, it } from "vitest";

import { buildSearchSpecs, searchSpecKey, type SearchSpecRequest } from "../src/index.js";

const brief = {
  originAirports: ["LHR"],
  destinationAirports: ["BER"],
  tripType: "round_trip" as const,
  departureWindow: { start: "2026-09-10", end: "2026-09-10" },
  stayNights: { minimum: 3, preferred: 4, maximum: 5 },
  travellers: { adults: 1, childrenAges: [], infants: 0 },
  cabin: "economy" as const,
  maxStops: 1,
  currency: "GBP",
  maximumPrice: null,
  preferredAirlines: [],
  excludedAirlines: [],
  context: ""
};

describe("shared search specifications", () => {
  it("produces the same key for semantically identical requests", () => {
    const request = buildSearchSpecs(brief, true)[0]!.request;
    const reordered = {
      fareContext: request.fareContext,
      maxConnections: request.maxConnections,
      cabin: request.cabin,
      passengers: request.passengers,
      slices: request.slices,
      liveMode: request.liveMode,
      apiVersion: request.apiVersion,
      provider: request.provider
    } as SearchSpecRequest;
    expect(searchSpecKey(request)).toBe(searchSpecKey(reordered));
  });

  it("separates passenger and cabin contexts", () => {
    const base = buildSearchSpecs(brief, true)[0]!.request;
    expect(searchSpecKey(base)).not.toBe(searchSpecKey({ ...base, cabin: "business" }));
    expect(searchSpecKey(base)).not.toBe(searchSpecKey({ ...base, passengers: [...base.passengers, { type: "adult" }] }));
  });

  it("limits a Trip to 24 shared specifications", () => {
    const many = buildSearchSpecs({
      ...brief,
      originAirports: ["LHR", "LGW", "LCY", "STN"],
      destinationAirports: ["BER", "FRA", "MUC", "HAM", "DUS", "CGN"],
      departureWindow: { start: "2026-09-01", end: "2026-09-30" }
    }, true);
    expect(many).toHaveLength(24);
  });
});
