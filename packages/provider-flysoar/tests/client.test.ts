import { describe, expect, it, vi } from "vitest";

import type { SearchSpecRequest } from "@agents/flight-domain";
import { clearFxCache } from "@agents/provider-duffel";

import {
  FallbackFlightSearchProvider,
  FlysoarMcpFlightSearchProvider,
  FlysoarProviderError
} from "../src/index.js";

const REQUEST: SearchSpecRequest = {
  provider: "official_duffel",
  apiVersion: "v1",
  tripType: "one_way",
  slices: [{
    originAirports: ["LHR"],
    destinationAirports: ["BER"],
    departureStart: "2026-08-20",
    departureEnd: "2026-08-20"
  }],
  stayNights: null,
  passenger: { adults: 1, childrenAges: [], infants: 0 },
  cabin: "economy",
  maxConnections: 1,
  currency: "USD",
  maximumPrice: null,
  fareContext: "public_beta"
};

const SOAR_PAYLOAD = {
  object: "flight_search",
  source: "duffel",
  offers: [{
    id: "off_soar_1",
    total_amount: "158.00",
    total_currency: "USD",
    bookable: true,
    expires_at: "2026-08-01T00:00:00Z",
    slices: [{
      origin: "LHR",
      destination: "BER",
      departure: "2026-08-20T19:30:00",
      arrival: "2026-08-20T22:20:00",
      segments: [{
        origin: "LHR",
        destination: "BER",
        departure: "2026-08-20T19:30:00",
        arrival: "2026-08-20T22:20:00",
        carrier_iata: "BA",
        flight_number: "0998"
      }]
    }]
  }],
  result_count: 1,
  price_currency: "USD"
};

describe("Flysoar MCP flight provider", () => {
  it("calls the public MCP tool and maps compact offers", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        method: string;
        params: { name: string; arguments: Record<string, unknown> };
      };
      expect(body.method).toBe("tools/call");
      expect(body.params).toEqual({
        name: "soar_search_flights",
        arguments: {
          origin: "LHR",
          destination: "BER",
          date: "2026-08-20",
          passengers: 1,
          cabin: "economy",
          max_connections: 1,
          currency: "USD",
          sort: "best",
          limit: 60
        }
      });
      expect(new Headers(init?.headers).get("mcp-protocol-version")).toBe("2025-06-18");
      return Response.json({
        jsonrpc: "2.0",
        id: "test",
        result: { structuredContent: SOAR_PAYLOAD, content: [] }
      }, { headers: { "x-request-id": "soar-request-1" } });
    });
    const provider = new FlysoarMcpFlightSearchProvider({ fetch });

    const result = await provider.search(REQUEST);

    expect(result).toMatchObject({
      provider: "flysoar_mcp",
      requestId: "soar-request-1",
      model: "flysoar-mcp",
      offers: [{
        providerOfferId: "off_soar_1",
        expiresAt: "2026-08-01T00:00:00Z",
        priceAmount: "158.00",
        currency: "USD",
        primaryAirlineCode: "BA",
        evidence: [{ domain: "flysoar.ai" }],
        slices: [{
          origin: "LHR",
          destination: "BER",
          departureDate: "2026-08-20",
          segments: [{
            departure: "2026-08-20T19:30:00Z",
            arrival: "2026-08-20T22:20:00Z",
            marketingAirlineCode: "BA",
            flightNumber: "BA0998"
          }]
        }]
      }]
    });
  });

  it("accepts text MCP content and reports rate limits", async () => {
    const provider = new FlysoarMcpFlightSearchProvider({
      fetch: vi.fn(async () => Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: {
          content: [{ type: "text", text: JSON.stringify({ ...SOAR_PAYLOAD, offers: [] }) }]
        }
      }))
    });
    await expect(provider.search(REQUEST)).resolves.toMatchObject({
      provider: "flysoar_mcp",
      offers: []
    });

    const limited = new FlysoarMcpFlightSearchProvider({
      fetch: vi.fn(async () => new Response("", {
        status: 429,
        headers: { "retry-after": "30" }
      }))
    });
    await expect(limited.search(REQUEST)).rejects.toMatchObject({
      name: "FlysoarProviderError",
      code: "rate_limited",
      retryAfterMs: 30_000
    });
  });

  it("converts Flysoar USD offers into a GBP Trip", async () => {
    clearFxCache();
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({
        jsonrpc: "2.0",
        id: "test",
        result: { structuredContent: SOAR_PAYLOAD, content: [] }
      }))
      .mockResolvedValueOnce(Response.json({
        result: "success",
        base_code: "USD",
        time_last_update_utc: "Thu, 30 Jul 2026 00:00:00 +0000",
        rates: { GBP: 0.8 }
      }));
    const provider = new FlysoarMcpFlightSearchProvider({ fetch });

    await expect(provider.search({ ...REQUEST, currency: "GBP" })).resolves.toMatchObject({
      offers: [{
        priceAmount: "126.40",
        currency: "GBP",
        evidence: [{
          title: expect.stringContaining("USD 158.00 → GBP @ 0.8")
        }]
      }]
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    clearFxCache();
  });
});

describe("fallback flight provider", () => {
  const emptyResult = {
    provider: "official_duffel" as const,
    requestId: "duffel",
    discoveryResponseId: "duffel",
    verificationResponseId: "duffel",
    model: "duffel",
    promptVersion: "duffel",
    offers: [],
    rejectionCounts: {}
  };
  const soarResult = {
    ...emptyResult,
    provider: "flysoar_mcp" as const,
    requestId: "soar",
    offers: [{
      itineraryKey: "soar-itinerary",
      providerOfferId: "soar-offer",
      priceAmount: "158.00",
      currency: "USD",
      fareBasis: "one_adult_total" as const,
      cabin: "economy" as const,
      slices: [{
        origin: "LHR",
        destination: "BER",
        departureDate: "2026-08-20",
        segments: [{
          origin: "LHR",
          destination: "BER",
          departure: "2026-08-20T19:30:00Z",
          arrival: "2026-08-20T22:20:00Z",
          marketingAirlineCode: "BA",
          marketingAirline: "BA",
          flightNumber: "BA0998"
        }]
      }],
      primaryAirlineCode: "BA",
      participatingAirlineCodes: ["BA"],
      evidence: [{
        url: "https://flysoar.ai/mcp",
        title: "Flysoar offer",
        domain: "flysoar.ai"
      }]
    }]
  };

  it("uses Flysoar after an empty primary result", async () => {
    const primary = {
      provider: "official_duffel" as const,
      search: vi.fn(async () => emptyResult)
    };
    const fallback = {
      provider: "flysoar_mcp" as const,
      search: vi.fn(async () => soarResult)
    };
    const provider = new FallbackFlightSearchProvider({ primary, fallback });

    await expect(provider.search(REQUEST)).resolves.toBe(soarResult);
    expect(fallback.search).toHaveBeenCalledWith(expect.objectContaining({
      provider: "flysoar_mcp"
    }));
  });

  it("uses Flysoar after a primary error and preserves empty primary on fallback error", async () => {
    const fallbackResult = {
      provider: "flysoar_mcp" as const,
      search: vi.fn(async () => soarResult)
    };
    const failedPrimary = {
      provider: "official_duffel" as const,
      search: vi.fn(async () => {
        throw new Error("Duffel unavailable");
      })
    };
    await expect(new FallbackFlightSearchProvider({
      primary: failedPrimary,
      fallback: fallbackResult
    }).search(REQUEST)).resolves.toBe(soarResult);

    const failedFallback = {
      provider: "flysoar_mcp" as const,
      search: vi.fn(async () => {
        throw new FlysoarProviderError("rate_limited");
      })
    };
    await expect(new FallbackFlightSearchProvider({
      primary: { provider: "official_duffel" as const, search: vi.fn(async () => emptyResult) },
      fallback: failedFallback
    }).search(REQUEST)).resolves.toBe(emptyResult);
  });
});
