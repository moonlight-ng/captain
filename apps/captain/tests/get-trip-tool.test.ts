import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CanonicalFlight, FlightOfferSnapshot, LegSearchSnapshot, Trip } from "@agents/flight-domain";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const TRIP_ID = "22222222-2222-4222-8222-222222222222";
const ORIGIN_ID = "33333333-3333-4333-8333-333333333333";
const DESTINATION_ID = "44444444-4444-4444-8444-444444444444";
const LEG_ID = "55555555-5555-4555-8555-555555555555";
const SEARCH_ID = "66666666-6666-4666-8666-666666666666";
const FLIGHT_KEY = "KQ101-LHR-NBO-20261101";

const state = vi.hoisted(() => ({ services: null as unknown }));

vi.mock("../services/app/services.js", () => ({
  getCaptainServices: async () => state.services
}));

import getTripTool from "../agent/tools/get_trip.js";
import selectTripFlightTool from "../agent/tools/select_trip_flight.js";

describe("get_trip normalized leg state", () => {
  beforeEach(() => {
    state.services = servicesFixture();
  });

  it("surfaces verified per-leg results and a web selection when legacy offers are empty", async () => {
    const result = await getTripTool.execute({}, toolContext() as never) as {
      offers: unknown[];
      legSearches: Array<{
        selectedFlight: {
          flightKey: string;
          primaryAirlineCode: string;
          price: { amount: string; currency: string };
          offer: { expired: boolean };
        };
        latestSearch: {
          complete: boolean;
          optionsChecked: number;
          picks: { cheapest: { flightKey: string; price: { amount: string } } };
        };
      }>;
    };

    expect(result.offers).toEqual([]);
    expect(result.legSearches[0]).toMatchObject({
      selectedFlight: {
        flightKey: FLIGHT_KEY,
        primaryAirlineCode: "KQ",
        price: { amount: "648.72", currency: "USD" },
        offer: { expired: false }
      },
      latestSearch: {
        complete: true,
        optionsChecked: 59,
        picks: {
          cheapest: {
            flightKey: "cheap-flight-key",
            price: { amount: "552.97" }
          }
        }
      }
    });
  });

  it("routes per-leg selections through the normalized trip-leg store", async () => {
    const services = state.services as ReturnType<typeof servicesFixture>;
    const result = await selectTripFlightTool.execute({
      legId: LEG_ID,
      itineraryKey: FLIGHT_KEY,
      selected: true
    }, toolContext() as never);

    expect(services.platformStore.setTripLegFlight).toHaveBeenCalledWith(
      USER_ID,
      TRIP_ID,
      LEG_ID,
      FLIGHT_KEY,
      expect.any(Date)
    );
    expect(services.trips.selectFlight).not.toHaveBeenCalled();
    expect(result).toEqual({
      tripId: TRIP_ID,
      legId: LEG_ID,
      flightKey: FLIGHT_KEY,
      selected: true
    });
  });
});

function servicesFixture() {
  const trip = tripFixture();
  const flight = flightFixture();
  const offer = offerFixture();
  const snapshot = snapshotFixture(flight, offer);
  return {
    env: { simplifiedMultiCityEnabled: true },
    trips: {
      offers: vi.fn(async () => []),
      selectFlight: vi.fn(async () => null)
    },
    platformStore: {
      listTrips: vi.fn(async () => [trip]),
      getActiveTrip: vi.fn(async () => trip),
      getTrackedFlightPrices: vi.fn(async () => null),
      getRecommendation: vi.fn(async () => null),
      ensureProfile: vi.fn(async () => ({ rankingMode: "balanced" as const })),
      getTripGraph: vi.fn(async () => ({
        cities: [
          {
            id: ORIGIN_ID,
            tripId: TRIP_ID,
            position: 0,
            label: "London",
            airportCodes: ["LHR"],
            arrivalWindow: null,
            departureWindow: { start: "2026-11-01", end: "2026-11-01" }
          },
          {
            id: DESTINATION_ID,
            tripId: TRIP_ID,
            position: 1,
            label: "Nairobi",
            airportCodes: ["NBO"],
            arrivalWindow: { start: "2026-11-02", end: "2026-11-02" },
            departureWindow: null
          }
        ],
        legs: [{
          id: LEG_ID,
          tripId: TRIP_ID,
          position: 0,
          originCityId: ORIGIN_ID,
          destinationCityId: DESTINATION_ID,
          departureWindow: { start: "2026-11-01", end: "2026-11-01" },
          arriveBy: "2026-11-04",
          selectedFlightKey: FLIGHT_KEY,
          latestSearchId: SEARCH_ID
        }]
      })),
      getLatestLegSearchSnapshot: vi.fn(async () => snapshot),
      getCanonicalFlight: vi.fn(async () => ({ flight, offers: [offer] })),
      getTrip: vi.fn(async () => trip),
      setTripLegFlight: vi.fn(async () => ({
        id: LEG_ID,
        tripId: TRIP_ID,
        position: 0,
        originCityId: ORIGIN_ID,
        destinationCityId: DESTINATION_ID,
        departureWindow: { start: "2026-11-01", end: "2026-11-01" },
        arriveBy: "2026-11-04",
        selectedFlightKey: FLIGHT_KEY,
        latestSearchId: SEARCH_ID
      }))
    }
  };
}

function tripFixture(): Trip {
  return {
    id: TRIP_ID,
    userId: USER_ID,
    title: "November trip",
    status: "tracking",
    version: 3,
    brief: {
      originAirports: ["LHR"],
      destinationAirports: ["NBO"],
      tripType: "one_way",
      departureWindow: { start: "2026-11-01", end: "2026-11-01" },
      stayNights: null,
      travellers: { adults: 1, childrenAges: [], infants: 0 },
      cabin: "economy",
      maxStops: 2,
      currency: "USD",
      maximumPrice: null,
      preferredAirlines: [],
      excludedAirlines: [],
      context: ""
    },
    archivedAt: null,
    archiveReason: null,
    createdAt: "2026-08-09T07:39:46.839Z",
    updatedAt: "2026-08-09T17:00:55.597Z"
  };
}

function flightFixture(): CanonicalFlight {
  return {
    key: FLIGHT_KEY,
    origin: "LHR",
    destination: "NBO",
    departureDate: "2026-11-01",
    segments: [{
      origin: "LHR",
      destination: "NBO",
      departure: "2026-11-01T17:25:00Z",
      arrival: "2026-11-02T05:00:00Z",
      marketingAirlineCode: "KQ",
      marketingAirline: "Kenya Airways",
      flightNumber: "KQ101"
    }],
    primaryAirlineCode: "KQ",
    participatingAirlineCodes: ["KQ"],
    stops: 0,
    durationMinutes: 695
  };
}

function offerFixture(): FlightOfferSnapshot {
  return {
    offerId: "off-kq",
    flightKey: FLIGHT_KEY,
    provider: "official_duffel",
    priceAmount: "648.72",
    currency: "USD",
    evidence: [{ url: "https://duffel.com/offers/off-kq", title: "Verified fare", domain: "duffel.com" }],
    observedAt: "2026-08-09T16:54:03.488Z",
    expiresAt: "2099-08-09T17:54:02.854Z"
  };
}

function snapshotFixture(
  flight: CanonicalFlight,
  offer: FlightOfferSnapshot
): LegSearchSnapshot {
  return {
    id: SEARCH_ID,
    tripId: TRIP_ID,
    legId: LEG_ID,
    revision: 2,
    status: "completed",
    requestedWindow: { start: "2026-11-01", end: "2026-11-01" },
    analysis: {
      complete: true,
      datesRequested: ["2026-11-01"],
      datesCompleted: ["2026-11-01"],
      failedDates: [],
      optionsChecked: 59,
      cheapest: {
        flightKey: "cheap-flight-key",
        departureDate: "2026-11-01",
        priceAmount: "552.97",
        currency: "USD",
        durationMinutes: 1285,
        stops: 1
      },
      fastest: {
        flightKey: FLIGHT_KEY,
        departureDate: "2026-11-01",
        priceAmount: "648.72",
        currency: "USD",
        durationMinutes: 695,
        stops: 0
      },
      balanced: {
        flightKey: FLIGHT_KEY,
        departureDate: "2026-11-01",
        priceAmount: "648.72",
        currency: "USD",
        durationMinutes: 695,
        stops: 0
      },
      cheapestByDate: [],
      observedAt: "2026-08-09T16:54:03.488Z"
    },
    flights: [flight],
    offers: [offer],
    createdAt: "2026-08-09T16:53:00.000Z",
    updatedAt: "2026-08-09T16:54:03.586Z",
    completedAt: "2026-08-09T16:54:03.586Z"
  };
}

function toolContext() {
  return {
    session: {
      auth: {
        current: {
          attributes: {
            captain_principal: "traveller",
            captain_user_id: USER_ID
          }
        }
      }
    }
  };
}
