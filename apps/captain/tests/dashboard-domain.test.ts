import { describe, expect, it } from "vitest";

import {
  flightDetailsFromDashboardFlight,
  workspaceFromTripDashboard,
  type TripDashboardPayload
} from "../src/domain.js";

describe("Trip dashboard adapter", () => {
  it("maps a multi-city platform Trip and current offer into the designed workspace", () => {
    const payload: TripDashboardPayload = {
      trip: {
        id: "11111111-1111-4111-8111-111111111111",
        title: "LOS to NYC to LON",
        status: "tracking",
        version: 1,
        brief: {
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
          ],
          travellers: { adults: 1, childrenAges: [], infants: 0 },
          cabin: "economy",
          maxStops: 1,
          currency: "NGN",
          maximumPrice: null,
          preferredAirlines: [],
          excludedAirlines: [],
          context: ""
        },
        createdAt: "2026-07-24T08:00:00.000Z",
        updatedAt: "2026-07-24T08:00:00.000Z"
      },
      watch: {
        status: "active",
        cadenceHours: 6,
        nextCheckAt: "2026-07-24T14:00:00.000Z",
        lastCheckAt: "2026-07-24T08:00:00.000Z"
      },
      offers: [{
        id: "offer-1",
        searchRunId: "run-1",
        itineraryKey: "itinerary-1",
        providerOfferId: "duffel-offer-1",
        providerSearchId: "duffel-search-1",
        price: 1_250_000,
        currency: "NGN",
        expiresAt: null,
        observedAt: "2026-07-24T08:05:00.000Z",
        snapshot: {
          route: "LOS → JFK → LHR",
          airlineCodes: ["BA"],
          flightNumbers: ["BA74", "BA178"],
          stops: 0,
          durationSeconds: 72_000,
          segments: [
            {
              airlineCode: "BA",
              airline: "British Airways",
              flightNumber: "BA74",
              origin: "LOS",
              destination: "JFK",
              departure: "2026-08-16T21:00:00.000Z",
              arrival: "2026-08-17T06:00:00.000Z"
            },
            {
              airlineCode: "BA",
              airline: "British Airways",
              flightNumber: "BA178",
              origin: "JFK",
              destination: "LHR",
              departure: "2026-08-23T18:00:00.000Z",
              arrival: "2026-08-24T06:00:00.000Z"
            }
          ]
        }
      }],
      selections: [{
        tripId: "11111111-1111-4111-8111-111111111111",
        itineraryKey: "itinerary-1",
        selectedBy: "agent",
        selectedAt: "2026-07-24T08:05:00.000Z"
      }]
    };
    payload.offers.push(
      {
        ...payload.offers[0]!,
        id: "offer-2",
        searchRunId: "run-2",
        itineraryKey: "itinerary-2",
        providerOfferId: "duffel-offer-2",
        providerSearchId: "duffel-search-2",
        price: 1_100_000,
        snapshot: {
          ...payload.offers[0]!.snapshot,
          airlineCodes: ["KQ"],
          segments: (payload.offers[0]!.snapshot.segments as Array<Record<string, unknown>>)
            .map((segment) => ({ ...segment, airlineCode: "KQ", airline: "Kenya Airways" }))
        }
      },
      {
        ...payload.offers[0]!,
        id: "offer-3",
        searchRunId: "run-3",
        itineraryKey: "itinerary-3",
        providerOfferId: "duffel-offer-3",
        providerSearchId: "duffel-search-3",
        price: 1_000_000,
        snapshot: {
          ...payload.offers[0]!.snapshot,
          airlineCodes: ["EK"],
          segments: (payload.offers[0]!.snapshot.segments as Array<Record<string, unknown>>)
            .map((segment) => ({ ...segment, airlineCode: "EK", airline: "Emirates" }))
        }
      }
    );
    payload.selections.push({
      tripId: payload.trip.id,
      itineraryKey: "itinerary-2",
      selectedBy: "person",
      selectedAt: "2026-07-24T08:06:00.000Z"
    });

    const workspace = workspaceFromTripDashboard(payload);
    expect(workspace.agent.key).toBe(payload.trip.id);
    expect(workspace.agent.brief.legs).toHaveLength(2);
    expect(workspace.browseFlights).toHaveLength(3);
    expect(workspace.reviewFlights).toHaveLength(2);
    expect(workspace.reviewFlights.map((flight) => [flight.itineraryKey, flight.reviewState])).toEqual([
      ["itinerary-1", "promoted"],
      ["itinerary-2", "retained"]
    ]);
    expect(workspace.browseFlights[2]).toMatchObject({
      itineraryKey: "itinerary-3",
      reviewState: "discovered",
      promotionReason: null
    });
    expect(workspace.browseFlights[0]).toMatchObject({
      marketingAirline: "British Airways",
      reviewState: "promoted",
      latest: {
        route: "LOS → JFK → LHR",
        price: 1_250_000,
        currency: "NGN"
      }
    });
    expect(flightDetailsFromDashboardFlight(workspace.browseFlights[0]!).observations).toHaveLength(1);
  });
});
