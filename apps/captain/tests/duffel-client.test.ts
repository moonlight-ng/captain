import { describe, expect, it, vi } from "vitest";

import {
  buildDuffelSearchPayload,
  DuffelClient,
  parseIsoDuration,
  parseRetryDelay
} from "../services/flights/duffel-client.js";
import { FlightProviderError } from "../services/flights/provider.js";

const request = {
  origin: "LHR",
  destination: "JFK",
  departureDate: "2026-09-01",
  returnDate: "2026-09-08",
  adults: 1,
  childrenAges: [10],
  infants: 0,
  cabin: "economy" as const,
  maxStops: 1,
  currency: "GBP",
  limit: 10,
  sort: "price" as const
};

describe("DuffelClient", () => {
  it("honours Duffel and standard retry headers", () => {
    expect(parseRetryDelay(new Headers({ "ratelimit-reset": "17" }), 1_000)).toBe(17_000);
    expect(parseRetryDelay(new Headers({ "retry-after": "9" }), 1_000)).toBe(9_000);
    expect(parseRetryDelay(
      new Headers({ "ratelimit-reset": "2000000000" }),
      1_999_999_990_000
    )).toBe(10_000);
  });

  it("builds Duffel v2 offer-request payloads including child ages", () => {
    expect(buildDuffelSearchPayload(request)).toEqual({
      slices: [
        { origin: "LHR", destination: "JFK", departure_date: "2026-09-01" },
        { origin: "JFK", destination: "LHR", departure_date: "2026-09-08" }
      ],
      passengers: [{ type: "adult" }, { age: 10 }],
      cabin_class: "economy",
      max_connections: 1
    });
  });

  it("maps and sorts live offer responses", async () => {
    const fetchMock = vi.fn(async () => Response.json({
      data: {
        id: "orq_1",
        offers: [{
          id: "off_1",
          total_amount: "321.50",
          total_currency: "GBP",
          owner: { name: "British Airways", iata_code: "BA" },
          slices: [{
            duration: "PT8H",
            segments: [{
              origin: { iata_code: "LHR" },
              destination: { iata_code: "JFK" },
              departing_at: "2026-09-01T10:00:00Z",
              arriving_at: "2026-09-01T18:00:00Z",
              marketing_carrier: { name: "British Airways", iata_code: "BA" },
              marketing_carrier_flight_number: "117",
              passengers: [{ cabin_class: "economy" }]
            }]
          }]
        }]
      }
    })) as unknown as typeof fetch;
    const client = new DuffelClient({ accessToken: "token", fetch: fetchMock });
    const result = await client.search(request);
    expect(result.searchId).toBe("orq_1");
    expect(result.offers[0]).toMatchObject({
      id: "off_1",
      price: 321.5,
      ownerAirlineCode: "BA",
      route: "LHR → JFK"
    });
  });

  it("classifies provider failures", async () => {
    const client = new DuffelClient({
      accessToken: "bad",
      fetch: vi.fn(async () => Response.json({ errors: [{ message: "No" }] }, { status: 401 })) as unknown as typeof fetch
    });
    await expect(client.search(request)).rejects.toMatchObject({ code: "unauthorized" } satisfies Partial<FlightProviderError>);
  });

  it("accepts an empty live result set", async () => {
    const client = new DuffelClient({
      accessToken: "token",
      fetch: vi.fn(async () => Response.json({ data: { id: "orq_empty", offers: [] } })) as unknown as typeof fetch
    });
    await expect(client.search(request)).resolves.toMatchObject({
      searchId: "orq_empty", totalResults: 0, offers: []
    });
  });

  it("rejects malformed provider JSON", async () => {
    const client = new DuffelClient({
      accessToken: "token",
      fetch: vi.fn(async () => Response.json({ data: { id: "missing-offers-shape", offers: [null] } })) as unknown as typeof fetch
    });
    await expect(client.search(request)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("classifies timeouts", async () => {
    const fetchMock = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    })) as unknown as typeof fetch;
    const client = new DuffelClient({ accessToken: "token", timeoutMs: 1, fetch: fetchMock });
    await expect(client.search(request)).rejects.toMatchObject({ code: "timeout" });
  });

  it("captures rate-limit reset delays", async () => {
    const client = new DuffelClient({
      accessToken: "token",
      fetch: vi.fn(async () => Response.json({
        errors: [{ message: "Slow down" }]
      }, {
        status: 429,
        headers: { "ratelimit-reset": "23" }
      })) as unknown as typeof fetch
    });
    await expect(client.search(request)).rejects.toMatchObject({
      code: "rate_limited", retryAfterMs: 23_000
    });
  });

  it("parses ISO durations", () => {
    expect(parseIsoDuration("P1DT2H30M")).toBe(95_400);
  });
});
