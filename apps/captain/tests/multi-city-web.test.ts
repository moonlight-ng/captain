import { afterEach, describe, expect, it, vi } from "vitest";

import {
  canonicalFlightHref,
  getCanonicalFlight,
  getTripLegSearch,
  selectTripLegFlight,
  startTripLegSearch
} from "../src/api.js";
import type {
  CanonicalFlight,
  FlightOfferSnapshot,
  TripCity,
  TripCityLeg
} from "../src/domain.js";
import { bestOffer, groupFlightsByDate, tripDateSpan } from "../src/multi-city-view.js";
import { priceDateStatus } from "../src/multi-city-view.js";

describe("multi-city web view models", () => {
  it("derives the trip span from city timing and leg windows", () => {
    const cities: TripCity[] = [
      city("nairobi", 0, null, { start: "2026-11-15", end: "2026-11-18" }),
      city("entebbe", 1, { start: "2026-11-19", end: "2026-11-19" }, { start: "2026-11-22", end: "2026-11-22" }),
      city("london", 2, { start: "2026-12-09", end: "2026-12-10" }, null)
    ];
    const legs: TripCityLeg[] = [leg("leg-1", 0, "nairobi", "entebbe", "2026-11-15", "2026-11-18")];

    expect(tripDateSpan(cities, legs)).toBe("Nov 15, 2026 – Dec 10, 2026");
  });

  it("groups canonical flights by departure date in chronological order", () => {
    const flights = [
      flight("flight-b", "2026-11-18"),
      flight("flight-a", "2026-11-16"),
      flight("flight-c", "2026-11-18")
    ];

    expect(groupFlightsByDate(flights).map(([date, items]) => [date, items.map((item) => item.key)]))
      .toEqual([
        ["2026-11-16", ["flight-a"]],
        ["2026-11-18", ["flight-b", "flight-c"]]
      ]);
  });

  it("shows the lowest verified seller offer for a canonical flight", () => {
    const offers: FlightOfferSnapshot[] = [
      offer("higher", "flight-a", "245.00"),
      offer("other-flight", "flight-b", "100.00"),
      offer("lower", "flight-a", "220.00")
    ];

    expect(bestOffer("flight-a", offers)?.offerId).toBe("lower");
    expect(bestOffer("missing", offers)).toBeNull();
  });

  it("distinguishes completed dates with no fares from dates still being checked", () => {
    expect(priceDateStatus("2026-11-15", ["2026-11-15"], [])).toBe("No fares");
    expect(priceDateStatus("2026-11-16", [], [])).toBe("Checking");
    expect(priceDateStatus("2026-11-17", [], [{ date: "2026-11-17" }])).toBe("Failed");
  });
});

describe("multi-city web API routes", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses leg-scoped search and selection endpoints", async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      calls.push({ input, ...(init ? { init } : {}) });
      if (input.endsWith("/selection")) return Response.json({ id: "leg-1" });
      return Response.json({ id: "search-1" });
    }));

    await startTripLegSearch("leg one");
    await getTripLegSearch("leg one", "search one");
    await selectTripLegFlight("leg one", "flight-key");

    expect(calls.map((call) => call.input)).toEqual([
      "/api/me/trip/legs/leg%20one/searches",
      "/api/me/trip/legs/leg%20one/searches/search%20one",
      "/api/me/trip/legs/leg%20one/selection"
    ]);
    expect(calls[2]?.init?.body).toBe(JSON.stringify({ flightKey: "flight-key" }));
  });

  it("loads a canonical flight without a trip identifier", async () => {
    const fetchMock = vi.fn(async () => Response.json({ flight: { key: "flight-key" }, offers: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await getCanonicalFlight("flight/key");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/flights/flight%2Fkey",
      expect.objectContaining({ credentials: "same-origin" })
    );
    expect(canonicalFlightHref("flight/key")).toBe("/flight/flight%2Fkey");
  });
});

function city(
  id: string,
  position: number,
  arrivalWindow: TripCity["arrivalWindow"],
  departureWindow: TripCity["departureWindow"]
): TripCity {
  return {
    id,
    tripId: "trip-1",
    position,
    label: id,
    airportCodes: ["AAA"],
    arrivalWindow,
    departureWindow
  };
}

function leg(
  id: string,
  position: number,
  originCityId: string,
  destinationCityId: string,
  start: string,
  end: string
): TripCityLeg {
  return {
    id,
    tripId: "trip-1",
    position,
    originCityId,
    destinationCityId,
    departureWindow: { start, end },
    arriveBy: null,
    selectedFlightKey: null,
    latestSearchId: null
  };
}

function flight(key: string, departureDate: string): CanonicalFlight {
  return {
    key,
    origin: "NBO",
    destination: "EBB",
    departureDate,
    segments: [{
      origin: "NBO",
      destination: "EBB",
      departure: `${departureDate}T09:00:00.000Z`,
      arrival: `${departureDate}T10:10:00.000Z`,
      marketingAirlineCode: "KQ",
      marketingAirline: "Kenya Airways",
      flightNumber: "KQ418"
    }],
    primaryAirlineCode: "KQ",
    participatingAirlineCodes: ["KQ"],
    stops: 0,
    durationMinutes: 70
  };
}

function offer(offerId: string, flightKey: string, priceAmount: string): FlightOfferSnapshot {
  return {
    offerId,
    flightKey,
    provider: "official_duffel",
    priceAmount,
    currency: "GBP",
    evidence: [{ url: "https://example.com/fare", title: "Verified fare", domain: "example.com" }],
    observedAt: "2026-08-08T12:00:00.000Z",
    expiresAt: "2026-08-08T13:00:00.000Z"
  };
}
