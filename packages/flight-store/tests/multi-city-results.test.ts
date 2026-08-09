import {
  legSearchSnapshotSchema,
  type Trip,
  type TripCity,
  type TripCityLeg
} from "@agents/flight-domain";
import { describe, expect, it } from "vitest";

import type { CompletedProviderOffer } from "../src/contracts.js";
import { multiCityLegRevision, type MultiCityLegMatch } from "../src/multi-city-results.js";

describe("multi-city leg results", () => {
  it("retains recommendation flights when a provider returns more than the snapshot limits", () => {
    const offers = Array.from({ length: 300 }, (_, index) => providerOffer(index));
    const revision = multiCityLegRevision(match, trip, offers, null, now);
    const flightKeys = new Set(revision.flights.map((flight) => flight.key));
    const recommendationKeys = [
      revision.analysis.cheapest?.flightKey,
      revision.analysis.fastest?.flightKey,
      revision.analysis.balanced?.flightKey,
      ...revision.analysis.cheapestByDate.map((pick) => pick.flightKey)
    ].filter((key): key is string => Boolean(key));

    expect(revision.analysis.optionsChecked).toBe(300);
    expect(revision.flights).toHaveLength(120);
    expect(revision.offers.length).toBeLessThanOrEqual(240);
    expect(recommendationKeys.every((key) => flightKeys.has(key))).toBe(true);
    expect(revision.offers.every((offer) => flightKeys.has(offer.flightKey))).toBe(true);
    expect(() => {
      legSearchSnapshotSchema.shape.analysis.parse(revision.analysis);
      legSearchSnapshotSchema.shape.flights.parse(revision.flights);
      legSearchSnapshotSchema.shape.offers.parse(revision.offers);
    }).not.toThrow();
  });
});

const now = new Date("2026-08-09T21:40:00.000Z");
const tripId = "7f24a4e7-8c95-4e01-8056-e4f0dadc3c09";
const origin: TripCity = {
  id: "b848267c-f837-42bc-b015-c2deaa238968",
  tripId,
  position: 0,
  label: "Lagos",
  airportCodes: ["LOS"],
  arrivalWindow: null,
  departureWindow: { start: "2026-10-29", end: "2026-11-04" }
};
const destination: TripCity = {
  id: "cb3330d4-028f-4aaa-8019-2efbd09494b5",
  tripId,
  position: 1,
  label: "London",
  airportCodes: ["LON"],
  arrivalWindow: null,
  departureWindow: null
};
const leg: TripCityLeg = {
  id: "b003ae77-5284-4f40-b47c-7858a3de875d",
  tripId,
  position: 0,
  originCityId: origin.id,
  destinationCityId: destination.id,
  departureWindow: { start: "2026-10-29", end: "2026-11-04" },
  arriveBy: null,
  selectedFlightKey: null,
  latestSearchId: null
};
const match: MultiCityLegMatch = { leg, origin, destination };
const trip: Trip = {
  id: tripId,
  userId: "d267e249-a6a8-43da-b366-71c305a05056",
  title: "London and Entebbe",
  status: "tracking",
  version: 1,
  brief: {
    originAirports: ["LOS"],
    destinationAirports: ["LOS"],
    tripType: "multi_city",
    departureWindow: leg.departureWindow,
    stayNights: null,
    legs: [{
      originAirports: ["LOS"],
      destinationAirports: ["LON"],
      departureWindow: leg.departureWindow,
      arriveBy: null
    }],
    travellers: { adults: 1, childrenAges: [], infants: 0 },
    cabin: "economy",
    maxStops: 1,
    currency: "USD",
    maximumPrice: null,
    preferredAirlines: [],
    excludedAirlines: [],
    context: ""
  },
  archivedAt: null,
  archiveReason: null,
  createdAt: now.toISOString(),
  updatedAt: now.toISOString()
};

function providerOffer(index: number): CompletedProviderOffer {
  const day = 29 + (index % 3);
  const departure = `2026-10-${String(day).padStart(2, "0")}T${String(index % 24).padStart(2, "0")}:00:00.000Z`;
  const arrival = `2026-10-${String(day).padStart(2, "0")}T${String(index % 24).padStart(2, "0")}:30:00.000Z`;
  const key = `LOS-LON-202610${String(day).padStart(2, "0")}-${String(index).padStart(4, "0")}`;
  const price = String(1_000 - index);
  return {
    itineraryKey: key,
    provider: "official_duffel",
    providerOfferId: `offer-${index}`,
    providerSearchId: "search-1",
    price: Number(price),
    priceAmount: price,
    currency: "USD",
    fareBasis: "one_adult_total",
    primaryAirlineCode: "BA",
    participatingAirlineCodes: ["BA"],
    evidence: [{ url: `https://example.com/offers/${index}`, title: "Verified fare", domain: "example.com" }],
    discoveryResponseId: "discovery-1",
    verificationResponseId: "verification-1",
    promptVersion: "v1",
    model: "duffel",
    verifiedAt: now.toISOString(),
    expiresAt: null,
    observedAt: now.toISOString(),
    snapshot: {
      segments: [{
        origin: "LOS",
        destination: "LHR",
        departure,
        arrival,
        airlineCode: "BA",
        airline: "British Airways",
        flightNumber: `BA${1000 + index}`
      }]
    }
  };
}
