import { describe, expect, it, vi } from "vitest";

import { clearFxCache, convertAmount, isSupportedFxCurrency } from "../src/fx.js";
import { DuffelError, DuffelFlightSearchProvider } from "../src/index.js";

describe("FX conversion", () => {
  it("returns identity quotes for the same currency", async () => {
    const result = await convertAmount(100, "USD", "usd");
    expect(result).toEqual({
      amount: 100,
      quote: expect.objectContaining({ from: "USD", to: "USD", rate: 1, provider: "identity" })
    });
  });

  it("converts GBP to USD and rejects unsupported currencies", async () => {
    clearFxCache();
    const fetch = vi.fn(async () => Response.json({
      result: "success",
      base_code: "GBP",
      time_last_update_utc: "Mon, 27 Jul 2026 00:00:01 +0000",
      rates: { USD: 1.3, NGN: 2000 }
    }));
    const usd = await convertAmount(100, "GBP", "USD", { fetch });
    expect(usd.amount).toBe(130);
    expect(usd.quote.rate).toBe(1.3);
    expect(isSupportedFxCurrency("NGN")).toBe(false);
    await expect(convertAmount(100, "GBP", "NGN", { fetch })).rejects.toThrow(/USD and GBP/u);
  });
});

describe("DuffelFlightSearchProvider", () => {
  it("searches every date in a one-way departure window", async () => {
    const requestedDates: string[] = [];
    const requestDates = new Map<string, string[]>();
    let requestNumber = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/air/offer_requests")) {
        const data = JSON.parse(String(init?.body)) as {
          data: { slices: Array<{ departure_date: string }> };
        };
        const dates = data.data.slices.map((slice) => slice.departure_date);
        requestedDates.push(...dates);
        const id = `orq_window_${requestNumber++}`;
        requestDates.set(id, dates);
        return Response.json({ data: { id } });
      }
      const requestId = new URL(url).searchParams.get("offer_request_id")!;
      const dates = requestDates.get(requestId)!;
      return Response.json({
        data: [testOffer(`off_${requestId}`, [{ origin: "SFO", destination: "JFK", date: dates[0]! }])],
        meta: { after: null }
      });
    });
    const provider = new DuffelFlightSearchProvider({ accessToken: "test", fetch });

    const result = await provider.search(testRequest([{
      originAirports: ["SFO"], destinationAirports: ["NYC"],
      departureStart: "2026-09-01", departureEnd: "2026-09-07"
    }]));

    expect(requestedDates).toEqual([
      "2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04",
      "2026-09-05", "2026-09-06", "2026-09-07"
    ]);
    expect(result.offers).toHaveLength(7);
    expect(result.promptVersion).toBe("duffel-exhaustive-window-v3");
  });

  it("searches the Cartesian product of multi-city departure windows", async () => {
    const requestedCombinations: string[][] = [];
    const requestDates = new Map<string, string[]>();
    let requestNumber = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/air/offer_requests")) {
        const data = JSON.parse(String(init?.body)) as {
          data: { slices: Array<{ departure_date: string }> };
        };
        const dates = data.data.slices.map((slice) => slice.departure_date);
        requestedCombinations.push(dates);
        const id = `orq_combo_${requestNumber++}`;
        requestDates.set(id, dates);
        return Response.json({ data: { id } });
      }
      const requestId = new URL(url).searchParams.get("offer_request_id")!;
      const dates = requestDates.get(requestId)!;
      return Response.json({
        data: [testOffer(`off_${requestId}`, [
          { origin: "ORD", destination: "LHR", date: dates[0]! },
          { origin: "LHR", destination: "BCN", date: dates[1]! }
        ])],
        meta: { after: null }
      });
    });
    const provider = new DuffelFlightSearchProvider({ accessToken: "test", fetch });

    const result = await provider.search(testRequest([
      { originAirports: ["ORD"], destinationAirports: ["LON"], departureStart: "2026-08-10", departureEnd: "2026-08-11" },
      { originAirports: ["LON"], destinationAirports: ["BCN"], departureStart: "2026-08-13", departureEnd: "2026-08-15" }
    ], "multi_city"));

    expect(requestedCombinations).toEqual([
      ["2026-08-10", "2026-08-13"], ["2026-08-10", "2026-08-14"],
      ["2026-08-10", "2026-08-15"], ["2026-08-11", "2026-08-13"],
      ["2026-08-11", "2026-08-14"], ["2026-08-11", "2026-08-15"]
    ]);
    expect(result.offers).toHaveLength(6);
  });

  it("adds the preferred return slice for round trips", async () => {
    let submittedSlices: Array<{ origin: string; destination: string; departure_date: string }> = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/air/offer_requests")) {
        const body = JSON.parse(String(init?.body)) as { data: { slices: typeof submittedSlices } };
        submittedSlices = body.data.slices;
        return Response.json({ data: { id: "orq_round" } });
      }
      return Response.json({
        data: [testOffer("off_round", [
          { origin: "LOS", destination: "LHR", date: "2026-09-01" },
          { origin: "LHR", destination: "LOS", date: "2026-09-08" }
        ])],
        meta: { after: null }
      });
    });
    const provider = new DuffelFlightSearchProvider({ accessToken: "test", fetch });

    const result = await provider.search({
      ...testRequest([{
        originAirports: ["LOS"], destinationAirports: ["LON"],
        departureStart: "2026-09-01", departureEnd: "2026-09-01"
      }]),
      tripType: "round_trip",
      stayNights: { minimum: 6, preferred: 7, maximum: 8 }
    });

    expect(submittedSlices).toEqual([
      { origin: "LOS", destination: "LON", departure_date: "2026-09-01" },
      { origin: "LON", destination: "LOS", departure_date: "2026-09-08" }
    ]);
    expect(result.offers[0]!.slices).toHaveLength(2);
  });

  it("rejects an itinerary that arrives after its city deadline", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes("/air/offer_requests")
        ? Response.json({ data: { id: "orq_deadline" } })
        : Response.json({
            data: [testOffer("off_late", [{
              origin: "JFK", destination: "BER", date: "2026-09-01", arrivalDate: "2026-09-02"
            }])],
            meta: { after: null }
          })
    );
    const provider = new DuffelFlightSearchProvider({ accessToken: "test", fetch });

    const result = await provider.search(testRequest([{
      originAirports: ["NYC"], destinationAirports: ["BER"],
      departureStart: "2026-09-01", departureEnd: "2026-09-01", arriveBy: "2026-09-01"
    }]));

    expect(result.offers).toEqual([]);
  });

  it("maps Duffel offers and converts into the Trip currency", async () => {
    clearFxCache();
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("open.er-api.com")) {
        return Response.json({
          result: "success",
          base_code: "GBP",
          time_last_update_utc: "Mon, 27 Jul 2026 00:00:01 +0000",
          rates: { USD: 1.25 }
        });
      }
      if (url.includes("/air/offer_requests")) {
        return Response.json({ data: { id: "orq_1" } });
      }
      return Response.json({
        data: [{
            id: "off_1",
            expires_at: "2026-09-01T12:30:00Z",
            total_amount: "800.00",
            total_currency: "GBP",
            owner: { name: "British Airways", iata_code: "BA" },
            slices: [
              {
                segments: [{
                  origin: { iata_code: "LOS" },
                  destination: { iata_code: "JFK" },
                  departing_at: "2026-08-17T22:00:00+01:00",
                  arriving_at: "2026-08-18T05:30:00-04:00",
                  marketing_carrier: { name: "British Airways", iata_code: "BA" },
                  marketing_carrier_flight_number: "74",
                  passengers: [{ cabin_class: "economy" }]
                }]
              },
              {
                segments: [{
                  origin: { iata_code: "JFK" },
                  destination: { iata_code: "LHR" },
                  departing_at: "2026-08-23T19:00:00-04:00",
                  arriving_at: "2026-08-24T07:10:00+01:00",
                  marketing_carrier: { name: "British Airways", iata_code: "BA" },
                  marketing_carrier_flight_number: "178",
                  passengers: [{ cabin_class: "economy" }]
                }]
              }
            ]
          }],
        meta: { after: null }
      }, { status: 200, headers: { "content-type": "application/json" } });
    });

    const provider = new DuffelFlightSearchProvider({ accessToken: "test", fetch });
    const result = await provider.search({
      provider: "official_duffel",
      apiVersion: "v1",
      tripType: "multi_city",
      slices: [
        {
          originAirports: ["LOS"],
          destinationAirports: ["NYC"],
          departureStart: "2026-08-17",
          departureEnd: "2026-08-17"
        },
        {
          originAirports: ["NYC"],
          destinationAirports: ["LON"],
          departureStart: "2026-08-23",
          departureEnd: "2026-08-23"
        }
      ],
      stayNights: null,
      passenger: { adults: 1, childrenAges: [], infants: 0 },
      cabin: "economy",
      maxConnections: 1,
      currency: "USD",
      maximumPrice: null,
      fareContext: "public_beta"
    });

    expect(result.offers).toHaveLength(1);
    expect(result.offers[0]).toMatchObject({
      currency: "USD",
      priceAmount: "1000.00",
      fareBasis: "one_adult_total",
      primaryAirlineCode: "BA"
    });
    expect(result.offers[0]!.evidence[0]!.title).toContain("GBP 800");
    expect(result.provider).toBe("official_duffel");
    expect(provider.provider).toBe("official_duffel");
  });

  it("uses Duffel pagination and returns every offer without an arbitrary cap", async () => {
    const rawOffers = Array.from({ length: 205 }, (_, index) => {
      const airline = [
        { code: "VS", name: "Virgin Atlantic" },
        { code: "BA", name: "British Airways" },
        { code: "AT", name: "Royal Air Maroc" }
      ][index % 3]!;
      return {
        id: `off_${index}`,
        expires_at: "2026-09-01T12:30:00Z",
        total_amount: String(500 + index),
        total_currency: "GBP",
        owner: { name: "Virgin Atlantic", iata_code: "VS" },
        slices: [{
          segments: [{
            origin: { iata_code: "LOS" },
            destination: { iata_code: "LHR" },
            departing_at: `2026-09-06T${String(10 + (index % 10)).padStart(2, "0")}:00:00+01:00`,
            arriving_at: `2026-09-06T${String(11 + (index % 10)).padStart(2, "0")}:00:00+01:00`,
            marketing_carrier: { name: airline.name, iata_code: airline.code },
            marketing_carrier_flight_number: String(100 + index),
            passengers: [{ cabin_class: "economy" }]
          }]
        }]
      };
    });
    const requestedUrls: string[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.includes("/air/offer_requests")) {
        return Response.json({ data: { id: "orq_paginated" } });
      }
      const secondPage = new URL(url).searchParams.has("after");
      return Response.json({
        data: secondPage ? rawOffers.slice(200) : rawOffers.slice(0, 200),
        meta: { after: secondPage ? null : "cursor_2" }
      });
    });
    const provider = new DuffelFlightSearchProvider({ accessToken: "test", fetch });

    const result = await provider.search({
      provider: "official_duffel",
      apiVersion: "v1",
      tripType: "one_way",
      slices: [{
        originAirports: ["LOS"],
        destinationAirports: ["LON"],
        departureStart: "2026-09-06",
        departureEnd: "2026-09-06"
      }],
      stayNights: null,
      passenger: { adults: 1, childrenAges: [], infants: 0 },
      cabin: "economy",
      maxConnections: 2,
      currency: "GBP",
      maximumPrice: null,
      fareContext: "public_beta"
    });

    expect(result.offers).toHaveLength(205);
    expect(new Set(result.offers.map((offer) => offer.primaryAirlineCode)))
      .toEqual(new Set(["VS", "BA", "AT"]));
    expect(result.offers[1]?.primaryAirlineCode).toBe("BA");
    expect(requestedUrls[0]).toContain("return_offers=false");
    expect(requestedUrls[0]).toContain("supplier_timeout=60000");
    expect(requestedUrls[1]).toContain("limit=200");
    expect(requestedUrls[2]).toContain("after=cursor_2");
  });

  it("rejects Trips outside USD/GBP", async () => {
    const provider = new DuffelFlightSearchProvider({ accessToken: "test", fetch: vi.fn() });
    await expect(provider.search({
      provider: "official_duffel",
      apiVersion: "v1",
      tripType: "one_way",
      slices: [{
        originAirports: ["LOS"],
        destinationAirports: ["ABV"],
        departureStart: "2026-08-17",
        departureEnd: "2026-08-17"
      }],
      stayNights: null,
      passenger: { adults: 1, childrenAges: [], infants: 0 },
      cabin: "economy",
      maxConnections: 1,
      currency: "NGN",
      maximumPrice: null,
      fareContext: "public_beta"
    })).rejects.toBeInstanceOf(DuffelError);
  });
});

function testRequest(
  slices: Array<{
    originAirports: string[];
    destinationAirports: string[];
    departureStart: string;
    departureEnd: string;
    arriveBy?: string;
  }>,
  tripType: "one_way" | "multi_city" = "one_way"
) {
  return {
    provider: "official_duffel" as const,
    apiVersion: "v1" as const,
    tripType,
    slices,
    stayNights: null,
    passenger: { adults: 1 as const, childrenAges: [] as [], infants: 0 as const },
    cabin: "economy" as const,
    maxConnections: 1,
    currency: "USD",
    maximumPrice: null,
    fareContext: "public_beta" as const
  };
}

function testOffer(
  id: string,
  slices: Array<{ origin: string; destination: string; date: string; arrivalDate?: string }>
) {
  return {
    id,
    expires_at: "2026-09-30T12:30:00Z",
    total_amount: "250.00",
    total_currency: "USD",
    owner: { name: "Test Air", iata_code: "TA" },
    slices: slices.map((slice, index) => ({
      segments: [{
        origin: { iata_code: slice.origin },
        destination: { iata_code: slice.destination },
        departing_at: `${slice.date}T10:00:00Z`,
        arriving_at: `${slice.arrivalDate ?? slice.date}T12:00:00Z`,
        marketing_carrier: { name: "Test Air", iata_code: "TA" },
        marketing_carrier_flight_number: String(100 + index),
        passengers: [{ cabin_class: "economy" }]
      }]
    }))
  };
}
