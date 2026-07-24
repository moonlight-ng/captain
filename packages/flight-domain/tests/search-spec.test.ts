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

  it("keeps an ordered multi-city itinerary in one Duffel request", () => {
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
    }, true);

    expect(spec?.request.slices).toEqual([
      { origin: "LOS", destination: "NYC", departureDate: "2026-08-16" },
      { origin: "NYC", destination: "LON", departureDate: "2026-08-23" }
    ]);
  });

  it("only combines connected, chronological multi-city legs", () => {
    const specs = buildSearchSpecs({
      ...brief,
      originAirports: ["LOS"],
      destinationAirports: ["LON"],
      tripType: "multi_city",
      departureWindow: { start: "2026-08-16", end: "2026-08-17" },
      stayNights: null,
      legs: [
        {
          originAirports: ["LOS"],
          destinationAirports: ["NYC", "JFK"],
          departureWindow: { start: "2026-08-16", end: "2026-08-17" }
        },
        {
          originAirports: ["NYC"],
          destinationAirports: ["LON"],
          departureWindow: { start: "2026-08-16", end: "2026-08-18" }
        }
      ]
    }, true);

    expect(specs).not.toHaveLength(0);
    expect(specs).toHaveLength(5);
    expect(specs.every(({ request }) =>
      request.slices[0]!.destination === request.slices[1]!.origin
      && request.slices[0]!.departureDate <= request.slices[1]!.departureDate
    )).toBe(true);
  });
});
