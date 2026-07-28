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
      return Response.json({
        data: {
          id: "orq_1",
          offers: [{
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
          }]
        }
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
    expect(result.webSearchCalls).toBe(0);
    expect(provider.provider).toBe("official_duffel");
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
