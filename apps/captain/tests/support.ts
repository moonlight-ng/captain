import type { FlightAgentBrief } from "../services/domain/types.js";
import type { FlightOffer } from "../services/flights/types.js";

export function defaultTestBrief(overrides: Partial<FlightAgentBrief> = {}): FlightAgentBrief {
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

export function testOffer(options: { price: number; code: string; airline: string; id?: string }): FlightOffer {
  const departure = "2026-09-01T10:00:00Z";
  const arrival = "2026-09-01T18:00:00Z";
  const segment = {
    airline: options.airline,
    airlineCode: options.code,
    flightNumber: `${options.code}101`,
    origin: "LHR",
    destination: "JFK",
    departure,
    arrival,
    durationSeconds: 28_800,
    cabin: "economy"
  };
  const route = { segments: [segment], durationSeconds: 28_800, stops: 0, route: "LHR → JFK" };
  return {
    id: options.id ?? `${options.code}-${options.price}`,
    price: options.price,
    currency: "GBP",
    airlines: [options.airline],
    ownerAirline: options.airline,
    ownerAirlineCode: options.code,
    route: route.route,
    durationSeconds: route.durationSeconds,
    stops: 0,
    routes: [route],
    outbound: route,
    conditions: {},
    rawOffer: { id: options.id ?? `${options.code}-${options.price}` }
  };
}
