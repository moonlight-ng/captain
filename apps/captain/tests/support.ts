import type { TripBrief } from "@agents/flight-domain";

export function defaultTestBrief(overrides: Partial<TripBrief> = {}): TripBrief {
  return {
    originAirports: ["LHR"],
    destinationAirports: ["JFK"],
    tripType: "round_trip",
    departureWindow: { start: "2026-09-01", end: "2026-09-01" },
    stayNights: { minimum: 6, preferred: 7, maximum: 8 },
    travellers: { adults: 1, childrenAges: [], infants: 0 },
    cabin: "economy",
    maxStops: 1,
    currency: "GBP",
    maximumPrice: null,
    preferredAirlines: [],
    excludedAirlines: [],
    context: "",
    ...overrides
  };
}
